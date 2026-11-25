/* Admin → Reviews: moderation queues (new, reported, photos to check, published, hidden) and the review settings.
 * Port of frontend/src/app/admin/reviews/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from "@angular/core";
import { BadgeCheck, ExternalLink, Flag, ImageOff, Play, RotateCcw, Trash2 } from "lucide-angular";
import { api, ApiError, latestOnly, quietly } from "../../core/api";
import { date } from "../../core/format";
import type { ReviewMedia } from "../../core/types";
import { Stars } from "../../shared/portal/helpers";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Pagination, Textarea, TextField, Toast } from "../../shared/ui/ui";

type R = {
  id: string; product: string; slug: string; author: string; phone: string | null; rating: number; title: string; body: string; status: string;
  verified: boolean; media: ReviewMedia[]; media_status: string; seller_reply: string; helpful_count: number; report_count: number;
  reports: { reason: string; note: string }[]; at: string;
};
type Counts = { published: number; pending: number; hidden: number; reported: number; media_pending: number };
type Topic = { name: string; words: string[] };
type Settings = {
  feature_reviews: boolean; reviews_need_approval: boolean; buyers_only: boolean; media_need_approval: boolean; photos: boolean; max_photos: number;
  videos: boolean; max_video_mb: number; media_public: boolean; report_hide_at: number; seller_can_report: boolean; min_body_chars: number;
  topics_enabled: boolean; topics: Topic[]; guidelines: string; default_topics: Topic[]; default_guidelines: string;
};

const QUEUES: Record<string, { label: string; query: Record<string, string | boolean>; hint: string }> = {
  pending: { label: "Waiting for a check", query: { status: "pending" }, hint: "Held for moderation, contained contact details or links, or were hidden after customer reports." },
  reported: { label: "Reported", query: { reported: true }, hint: "Customers or sellers flagged these. Publish to dismiss the reports, hide to uphold them." },
  media: { label: "Photos to check", query: { media_pending: true }, hint: "Photos and videos waiting for approval (Settings → photos need approval)." },
  published: { label: "Published", query: { status: "published" }, hint: "Live on product pages and counted in ratings." },
  hidden: { label: "Hidden", query: { status: "hidden" }, hint: "Removed by staff. Not shown and not counted." },
};

@Component({
  selector: "pc-review-moderation",
  imports: [Stars, Icon, PageLoader, Button, EmptyState, Input, Pagination],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <p class="mb-3 text-sm text-ink-soft">{{ queues[queue()].hint }}</p>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <input pcInput placeholder="Product, customer or review text" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="max-w-xs" aria-label="Search reviews" />
      @for (x of stars; track x) {
        <button (click)="rating.set(x); page.set(1)" [class]="rating() === x ? 'rounded-full px-3 py-1 text-sm bg-peacock text-white' : 'rounded-full px-3 py-1 text-sm bg-white ring-1 ring-line'">{{ x ? x + "★" : "All stars" }}</button>
      }
      <label class="ml-1 flex items-center gap-1.5 text-sm"><input type="checkbox" class="accent-peacock" [checked]="onlyMedia()" (change)="onlyMedia.set($any($event.target).checked); page.set(1)" /> With photos or video</label>
    </div>
    @if (!items()) {
      <pc-page-loader />
    } @else if (items()!.length === 0) {
      <pc-empty-state title="Nothing here" body="New items appear here as customers write and report reviews." [hasAction]="false" />
    } @else {
      <div class="flex flex-col gap-3">
        @for (r of items()!; track r.id) {
          <section [class]="cx('rounded-xl bg-white p-4', r.report_count > 0 && 'ring-2 ring-vermilion/40')" data-testid="admin-review">
            <div class="flex flex-wrap items-center gap-2">
              <pc-stars [value]="r.rating" />
              <p class="font-semibold">{{ r.title || "(no headline)" }}</p>
              @if (r.verified) {
                <span class="flex items-center gap-0.5 text-xs font-semibold text-leaf"><svg [pcIcon]="BadgeCheck" class="h-3.5 w-3.5" /> Verified purchase</span>
              } @else {
                <span class="text-xs text-ink-faint">Not a verified purchase</span>
              }
              <span [class]="cx('ml-auto rounded-full px-2 py-0.5 text-xs font-semibold', r.status === 'published' ? 'bg-leaf-light text-leaf' : r.status === 'pending' ? 'bg-marigold-light text-ink' : 'bg-mist text-ink-faint')">{{ r.status }}</span>
            </div>
            <p class="mt-0.5 text-sm text-ink-faint">
              {{ r.author || "Customer" }}{{ r.phone ? " (" + r.phone + ")" : "" }} on{{ " " }}<a [href]="'/p/' + r.slug + '#reviews'" target="_blank" rel="noopener noreferrer" class="text-peacock hover:underline">{{ r.product }} <svg [pcIcon]="ExternalLink" class="inline h-3 w-3" /></a>, {{ date(r.at) }} · {{ r.helpful_count }} helpful
            </p>
            @if (r.body) {<p class="mt-2 whitespace-pre-line">{{ r.body }}</p>}
            @if (r.media.length > 0) {
              <div class="mt-2">
                <div class="flex flex-wrap gap-2">
                  @for (m of r.media; track m.url) {
                    <a [href]="m.url" target="_blank" rel="noopener noreferrer" class="relative block h-20 w-20 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                      @if (m.kind === "video") {
                        @if (m.poster_url) {<img [src]="m.poster_url" alt="" class="h-full w-full object-cover" />} @else {<span class="flex h-full items-center justify-center text-xs">Video</span>}
                        <svg [pcIcon]="Play" class="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
                      } @else {
                        <img [src]="m.url" alt="" class="h-full w-full object-cover" />
                      }
                    </a>
                  }
                </div>
                <p class="mt-1 text-xs text-ink-faint">Photos and videos: <span class="font-semibold">{{ r.media_status === "pending" ? "waiting for approval" : r.media_status }}</span></p>
              </div>
            }
            @if (r.reports.length > 0) {
              <ul class="mt-2 rounded-lg bg-vermilion-light p-2 text-sm">
                @for (x of r.reports; track $index) {<li class="flex gap-1.5"><svg [pcIcon]="Flag" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion" /> <span><span class="font-semibold">{{ x.reason }}</span>{{ x.note ? ": " + x.note : "" }}</span></li>}
              </ul>
            }
            @if (r.seller_reply) {<p class="mt-2 rounded-lg bg-mist p-2 text-sm"><span class="font-semibold">Seller replied:</span> {{ r.seller_reply }}</p>}
            <div class="mt-3 flex flex-wrap gap-2">
              @if (r.status !== "published") {<button pcButton size="sm" (click)="act(r, 'publish', 'Review published')">Publish</button>}
              @if (r.status !== "hidden") {<button pcButton size="sm" variant="danger" (click)="act(r, 'hide', 'Review hidden')"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Hide</button>}
              @if (r.media.length > 0 && r.media_status !== "published") {<button pcButton size="sm" variant="secondary" (click)="act(r, 'publish-media', 'Photos approved')">Approve photos</button>}
              @if (r.media.length > 0 && r.media_status !== "hidden") {<button pcButton size="sm" variant="secondary" (click)="act(r, 'hide-media', 'Photos removed')"><svg [pcIcon]="ImageOff" class="h-4 w-4" /> Remove photos</button>}
              @if (r.report_count > 0 && r.status === "published") {<button pcButton size="sm" variant="ghost" (click)="act(r, 'dismiss-reports', 'Reports dismissed')">Dismiss reports</button>}
            </div>
          </section>
        }
      </div>
    }
    @if (items()) {<pc-pagination [page]="page()" [pageSize]="30" [total]="total()" (pageChange)="page.set($event)" />}
  `,
})
export class ReviewModeration {
  readonly queue = input.required<string>();
  readonly counts = output<Counts>();
  private readonly toast = inject(Toast);
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly ExternalLink = ExternalLink;
  protected readonly Flag = Flag;
  protected readonly ImageOff = ImageOff;
  protected readonly Play = Play;
  protected readonly Trash2 = Trash2;
  protected readonly cx = cx;
  protected readonly date = date;
  protected readonly queues = QUEUES;
  protected readonly stars = ["", "1", "2", "3", "4", "5"];
  protected readonly rating = signal("");
  protected readonly onlyMedia = signal(false);
  protected readonly items = signal<R[] | null>(null);
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  private readonly track = latestOnly();

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const queue = this.queue(), rating = this.rating(), onlyMedia = this.onlyMedia(), q = this.q(), page = this.page();
      clearTimeout(t);
      t = setTimeout(() => this.load(queue, rating, onlyMedia, q, page), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  private load(queue = this.queue(), rating = this.rating(), onlyMedia = this.onlyMedia(), q = this.q(), page = this.page()): Promise<unknown> {
    return this.track(
      api<{ items: R[]; total: number; counts: Counts }>("/api/admin/reviews", { query: { ...QUEUES[queue].query, rating: rating || undefined, media: onlyMedia || undefined, q, page } }),
      (r) => { this.items.set(r.items); this.total.set(r.total); this.counts.emit(r.counts); },
    );
  }

  protected async act(r: R, action: string, done: string): Promise<void> {
    try {
      await api(`/api/admin/reviews/${r.id}/${action}`, { method: "POST" });
      this.toast.show(done);
      void this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update", "error");
    }
  }
}

@Component({
  selector: "pc-review-toggle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label [class]="disabled() ? 'flex items-start gap-3 rounded-lg border border-line p-3 opacity-50' : 'flex items-start gap-3 rounded-lg border border-line p-3'">
      <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="checked()" [disabled]="disabled()" (change)="changed.emit($any($event.target).checked)" />
      <span><span class="font-semibold">{{ title() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
    </label>
  `,
})
export class ReviewToggle {
  readonly checked = input.required<boolean>();
  readonly title = input.required<string>();
  readonly hint = input.required<string>();
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}

type NumKey = "min_body_chars" | "max_photos" | "max_video_mb" | "report_hide_at";

@Component({
  selector: "pc-review-settings-form",
  imports: [ReviewToggle, Icon, PageLoader, Button, ErrorNote, Input, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!s()) {
      <pc-page-loader />
    } @else {
      @let s = this.s()!;
      <form (submit)="save($event)" class="flex max-w-3xl flex-col gap-4">
        <pc-error-note [message]="error()" />
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Who can review</h2>
          <pc-review-toggle [checked]="s.feature_reviews" (changed)="set('feature_reviews', $event)" title="Ratings and reviews" hint="Off hides reviews everywhere and stops new ones." />
          <pc-review-toggle [checked]="s.buyers_only" (changed)="set('buyers_only', $event)" title="Verified buyers only (recommended)" hint="Only customers whose order was delivered can write. Off: any signed-in customer, shown without the 'Verified purchase' badge." />
          <p class="rounded-lg bg-mist p-3 text-sm text-ink-soft sm:col-span-2">Visitors who are not signed in can always read reviews and see ratings. Writing, voting “helpful” and reporting need a signed-in account; sellers can never review their own products.</p>
          <pc-text-field label="Shortest review text (characters)" inputmode="numeric" [value]="'' + s.min_body_chars" [filter]="numOnly" (valueChange)="setNum('min_body_chars', $event)" hint="0 lets customers leave just a star rating. Up to 500." />
        </section>

        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Photos and videos in reviews</h2>
          <pc-review-toggle [checked]="s.photos" (changed)="set('photos', $event)" title="Customers can add photos" hint="JPG, PNG or WebP. Shown in the review and in the customer photo gallery on the product page." />
          <pc-text-field label="Photos per review" inputmode="numeric" [value]="'' + s.max_photos" [filter]="numOnly" (valueChange)="setNum('max_photos', $event)" hint="0 to 10" [disabled]="!s.photos" />
          <pc-review-toggle [checked]="s.videos" (changed)="set('videos', $event)" title="Customers can add a video" hint="One MP4 or WebM video per review." />
          <pc-text-field label="Largest review video (MB)" inputmode="numeric" [value]="'' + s.max_video_mb" [filter]="numOnly" (valueChange)="setNum('max_video_mb', $event)" hint="5 to 100" [disabled]="!s.videos" />
          <pc-review-toggle [checked]="s.media_need_approval" (changed)="set('media_need_approval', $event)" title="Check photos and videos before they appear" hint="New photos wait in 'Photos to check'. The review text is published as usual." />
          <pc-review-toggle [checked]="s.media_public" (changed)="set('media_public', $event)" title="Show customer photos to visitors who are not signed in" hint="Off: only signed-in shoppers see customer photos and videos." />
        </section>

        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Moderation</h2>
          <pc-review-toggle [checked]="s.reviews_need_approval" (changed)="set('reviews_need_approval', $event)" title="Hold every new review for a check" hint="Reviews appear only after staff publish them. Reviews with phone numbers, emails or links are always held." />
          <pc-review-toggle [checked]="s.seller_can_report" (changed)="set('seller_can_report', $event)" title="Sellers can report reviews" hint="Sellers cannot delete reviews; they can ask staff to check one." />
          <pc-text-field label="Hide a review after this many reports" inputmode="numeric" [value]="'' + s.report_hide_at" [filter]="numOnly" (valueChange)="setNum('report_hide_at', $event)" hint="It waits for staff in 'Waiting for a check'. 0 = never hide automatically." />
        </section>

        <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
          <h2 class="text-lg font-semibold">What customers talk about</h2>
          <pc-review-toggle [checked]="s.topics_enabled" (changed)="set('topics_enabled', $event)" title="Show topic chips on product pages" hint="Counts reviews that mention each topic, with how many were positive (4-5 stars) or negative (1-2 stars). Shoppers click a topic to read those reviews. No AI needed." />
          <div class="flex flex-col gap-2">
            @for (t of s.topics; track $index; let i = $index) {
              <div class="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
                <input pcInput [value]="t.name" maxlength="30" [attr.aria-label]="'Topic ' + (i + 1) + ' name'" (input)="setTopic(i, $any($event.target).value)" />
                <input pcInput [value]="words()[i] ?? ''" [attr.aria-label]="'Topic ' + (i + 1) + ' words'" placeholder="words, separated, by commas" (input)="setWord(i, $any($event.target).value)" />
                <button pcButton type="button" variant="ghost" size="sm" (click)="removeTopic(i)">Remove</button>
              </div>
            }
          </div>
          <div class="flex flex-wrap gap-2">
            <button pcButton type="button" variant="secondary" size="sm" [disabled]="s.topics.length >= 20" (click)="addTopic()">Add topic</button>
            <button pcButton type="button" variant="ghost" size="sm" (click)="restoreTopics()"><svg [pcIcon]="RotateCcw" class="h-4 w-4" /> Restore the standard topics</button>
          </div>
        </section>

        <section class="flex flex-col gap-2 rounded-xl bg-white p-5">
          <h2 class="text-lg font-semibold">Review guidelines</h2>
          <p class="text-sm text-ink-soft">Shown to customers above the review form.</p>
          <textarea pcTextarea rows="5" maxlength="2000" [value]="s.guidelines" (input)="set('guidelines', $any($event.target).value)" aria-label="Review guidelines"></textarea>
          <button pcButton type="button" variant="ghost" size="sm" class="self-start" (click)="set('guidelines', s.default_guidelines)"><svg [pcIcon]="RotateCcw" class="h-4 w-4" /> Use the standard text</button>
        </section>
        <button pcButton type="submit" [loading]="busy()" class="self-start">Save review settings</button>
      </form>
    }
  `,
})
export class ReviewSettingsForm {
  private readonly toast = inject(Toast);
  protected readonly RotateCcw = RotateCcw;
  protected readonly s = signal<Settings | null>(null);
  protected readonly words = signal<string[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly numOnly = (v: string) => String(Number(v.replace(/\D/g, "")) || 0);

  constructor() {
    api<Settings>("/api/admin/review-settings").then((x) => { this.s.set(x); this.words.set(x.topics.map((t) => t.words.join(", "))); }).catch(quietly);
  }

  protected set<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.s.update((s) => (s ? { ...s, [k]: v } : s));
  }

  protected setNum(k: NumKey, v: string): void {
    this.set(k, Number(v.replace(/\D/g, "")) || 0);
  }

  protected setTopic(i: number, name: string): void {
    this.set("topics", this.s()!.topics.map((x, k) => (k === i ? { ...x, name } : x)));
  }

  protected setWord(i: number, v: string): void {
    this.words.update((w) => w.map((x, k) => (k === i ? v : x)));
  }

  protected removeTopic(i: number): void {
    this.set("topics", this.s()!.topics.filter((_, k) => k !== i));
    this.words.update((w) => w.filter((_, k) => k !== i));
  }

  protected addTopic(): void {
    this.set("topics", [...this.s()!.topics, { name: "", words: [] }]);
    this.words.update((w) => [...w, ""]);
  }

  protected restoreTopics(): void {
    const s = this.s()!;
    this.set("topics", s.default_topics);
    this.words.set(s.default_topics.map((t) => t.words.join(", ")));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const s = this.s();
    if (!s) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const words = this.words();
      const topics = s.topics.map((t, i) => ({ name: t.name.trim(), words: (words[i] ?? "").split(",").map((w) => w.trim()).filter(Boolean) })).filter((t) => t.name);
      const body = {
        feature_reviews: s.feature_reviews, reviews_need_approval: s.reviews_need_approval, buyers_only: s.buyers_only, media_need_approval: s.media_need_approval,
        photos: s.photos, max_photos: s.max_photos, videos: s.videos, max_video_mb: s.max_video_mb, media_public: s.media_public, report_hide_at: s.report_hide_at,
        seller_can_report: s.seller_can_report, min_body_chars: s.min_body_chars, topics_enabled: s.topics_enabled, topics, guidelines: s.guidelines,
      };
      const x = await api<Settings>("/api/admin/review-settings", { method: "PUT", body });
      this.s.set(x);
      this.words.set(x.topics.map((t) => t.words.join(", ")));
      this.toast.show("Review settings saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-reviews-page",
  imports: [PageHeader, Tabs, ReviewModeration, ReviewSettingsForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Reviews" sub="Check new and reported reviews, customer photos and videos, and set who can review. Ratings recalculate at once." />
      <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabs()" />
      @if (tab() === "settings") {
        <pc-review-settings-form />
      } @else {
        <!-- a new queue starts fresh (the reference's key={tab}) -->
        @for (q of [tab()]; track q) {<pc-review-moderation [queue]="q" (counts)="counts.set($event)" />}
      }
    </div>
  `,
})
export class AdminReviewsPage {
  protected readonly tab = signal("pending");
  protected readonly counts = signal<Counts | null>(null);
  protected readonly tabs = computed(() => {
    const c = this.counts();
    return [
      { value: "pending", label: QUEUES["pending"].label, count: c?.pending },
      { value: "reported", label: QUEUES["reported"].label, count: c?.reported },
      { value: "media", label: QUEUES["media"].label, count: c?.media_pending },
      { value: "published", label: QUEUES["published"].label, count: c?.published },
      { value: "hidden", label: QUEUES["hidden"].label, count: c?.hidden },
      { value: "settings", label: "Settings" },
    ];
  });
}
