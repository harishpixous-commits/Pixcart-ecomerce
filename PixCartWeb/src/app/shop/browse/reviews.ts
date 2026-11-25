/*
 * Ratings and reviews on the product page.
 * Anyone can read. Writing, "helpful" votes and reports need a signed-in customer; by default only customers
 * whose order was delivered can write (Admin → Reviews → Settings). Reviews can carry photos and a video;
 * every customer photo and video also appears in a gallery with the review it belongs to.
 * Port of components/reviews.tsx.
 */

import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild,
} from "@angular/core";
import { BadgeCheck, Camera, ChevronLeft, ChevronRight, Flag, ImagePlus, Pencil, Play, Star, ThumbsDown, ThumbsUp, Trash2, Video, X } from "lucide-angular";
import { ApiError, api, quietly, uploadWithProgress } from "../../core/api";
import { date } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { CustomerMediaItem, ReviewMedia, ReviewSettingsPublic } from "../../core/types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Modal, Select, TextField, Textarea, Toast } from "../../shared/ui/ui";
import { portalToBody } from "./product-gallery";

type Topic = { name: string; count: number; positive: number; negative: number; positive_pct: number; tone: "positive" | "negative" | "mixed" };
type Item = {
  id: string; rating: number; title: string; body: string; author: string; verified: boolean; seller_reply: string; helpful_count: number;
  created_at: string; media: ReviewMedia[]; voted: boolean; reported: boolean; mine: boolean;
};
type Mine = { rating: number; title: string; body: string; media: ReviewMedia[]; status: string; media_status: string };
type R = {
  rating_avg: number; rating_count: number; distribution: Record<string, number>; summary: string; topics: Topic[];
  with_media_count: number; verified_count: number; media: CustomerMediaItem[]; media_total: number; media_hidden: boolean;
  can_review: boolean; cannot_review_reason: "off" | "sign_in" | "own_product" | "not_purchased" | null; mine: Mine | null;
  settings: ReviewSettingsPublic; items: Item[]; total: number; page: number; has_more: boolean;
};

const STAR_WORDS = ["", "Hate it", "Didn't like it", "It's OK", "Liked it", "Love it"];

/** Five stars, filled up to the (rounded) value. */
@Component({
  selector: "pc-stars",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "inline-flex", "[attr.aria-label]": "value() + ' out of 5 stars'" },
  template: `@for (n of [1, 2, 3, 4, 5]; track n) {<svg [pcIcon]="Star" [class]="size() + ' ' + (n <= rounded() ? 'fill-marigold text-marigold' : 'text-line')" />}`,
})
export class Stars {
  readonly value = input.required<number>();
  readonly size = input("h-4 w-4");
  protected readonly Star = Star;
  protected readonly rounded = computed(() => Math.round(this.value()));
}

/* ---------------------------------------------------------------- media viewer (customer photos and videos) */

@Component({
  selector: "pc-media-thumb",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="pick.emit()" [attr.aria-label]="label()" [class]="cls()">
      @if (m().kind === "video") {
        @if (m().poster_url) {<img [src]="m().poster_url" alt="" class="h-full w-full object-cover" />}
        @else {<video [src]="m().url + '#t=0.5'" preload="metadata" [muted]="true" class="h-full w-full object-cover"></video>}
        <svg [pcIcon]="Play" class="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
      } @else {
        <img [src]="m().url" alt="" class="h-full w-full object-cover" loading="lazy" />
      }
    </button>
  `,
})
export class MediaThumb {
  readonly m = input.required<ReviewMedia>();
  readonly label = input.required<string>();
  readonly extra = input<string | undefined>(undefined, { alias: "thumbClass" });
  readonly pick = output<void>();
  protected readonly Play = Play;
  protected readonly cls = computed(() => cx("relative shrink-0 overflow-hidden rounded-lg bg-mist ring-1 ring-line hover:ring-2 hover:ring-peacock", this.extra() ?? "h-20 w-20"));
}

@Component({
  selector: "pc-customer-media-viewer",
  imports: [Icon, MediaThumb, Stars],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (cur(); as c) {
      <div class="fixed inset-0 z-[70] flex items-stretch justify-center bg-ink/70 sm:p-6" (mousedown)="close.emit()" role="dialog" aria-modal="true" aria-label="Customer photos and videos">
        <div class="flex w-full max-w-6xl flex-col overflow-hidden bg-white sm:rounded-2xl" (mousedown)="$event.stopPropagation()">
          <div class="flex items-center justify-between border-b border-line px-4 py-3">
            <p class="font-semibold">Customer photos and videos <span class="font-normal text-ink-faint">({{ i() + 1 }} of {{ total() }})</span></p>
            <button type="button" (click)="close.emit()" aria-label="Close" class="rounded-full p-2 hover:bg-mist"><svg [pcIcon]="X" class="h-5 w-5" /></button>
          </div>
          <div class="grid min-h-0 flex-1 md:grid-cols-[1fr_320px]">
            <div class="relative flex min-h-[45vh] items-center justify-center bg-ink/[0.03]">
              @for (k of [c.url]; track k) {
                @if (c.kind === "video") {
                  <video [src]="c.url" [attr.poster]="c.poster_url || null" controls autoplay playsinline class="max-h-[70vh] w-full"></video>
                } @else {
                  <img [src]="c.url" [alt]="'Photo from ' + c.author + '\\'s review'" class="max-h-[70vh] w-full object-contain" />
                }
              }
              @if (i() > 0) {<button type="button" (click)="go(-1)" aria-label="Previous" class="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow hover:bg-white"><svg [pcIcon]="ChevronLeft" class="h-6 w-6" /></button>}
              @if (i() < items().length - 1) {<button type="button" (click)="go(1)" aria-label="Next" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow hover:bg-white"><svg [pcIcon]="ChevronRight" class="h-6 w-6" /></button>}
            </div>
            <aside class="overflow-y-auto border-t border-line p-4 md:border-l md:border-t-0">
              <div class="flex items-center gap-2">
                <span class="flex h-8 w-8 items-center justify-center rounded-full bg-peacock-light font-semibold text-peacock">{{ c.author.slice(0, 1).toUpperCase() }}</span>
                <p class="font-semibold">{{ c.author }}</p>
              </div>
              <div class="mt-2 flex items-center gap-2"><pc-stars [value]="c.rating" /> @if (c.title) {<p class="font-semibold">{{ c.title }}</p>}</div>
              <p class="mt-1 text-xs text-ink-faint">Reviewed on {{ date(c.created_at) }}</p>
              @if (c.verified) {<p class="mt-1 flex items-center gap-1 text-xs font-semibold text-leaf"><svg [pcIcon]="BadgeCheck" class="h-3.5 w-3.5" /> Verified purchase</p>}
              @if (c.body) {<p class="mt-2 whitespace-pre-line text-sm text-ink-soft">{{ c.body }}</p>}
            </aside>
          </div>
          <div #strip class="scroll-x flex gap-2 overflow-x-auto border-t border-line p-3">
            @for (m of items(); track m.url + "-" + k; let k = $index) {
              <span [attr.data-i]="k">
                <pc-media-thumb [m]="m" (pick)="i.set(k)" [label]="'Show item ' + (k + 1)" [thumbClass]="k === i() ? 'h-16 w-16 ring-2 ring-peacock' : 'h-16 w-16'" />
              </span>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class CustomerMediaViewer {
  readonly items = input.required<CustomerMediaItem[]>();
  readonly start = input.required<number>();
  readonly total = input.required<number>();
  readonly loadMore = input<(() => void) | undefined>(undefined);
  readonly close = output<void>();
  protected readonly X = X;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly date = date;
  protected readonly i = signal(0);
  protected readonly cur = computed(() => this.items()[Math.min(this.i(), this.items().length - 1)]);
  private readonly strip = viewChild<ElementRef<HTMLDivElement>>("strip");

  constructor() {
    portalToBody();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.close.emit();
      if (e.key === "ArrowRight") this.go(1);
      if (e.key === "ArrowLeft") this.go(-1);
    };
    document.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    });
    effect(() => {
      const i = this.i(), n = this.items().length, total = this.total(), more = this.loadMore();
      if (more && i >= n - 3 && n < total) untracked(more);
    });
    effect(() => {
      const i = this.i();
      const strip = this.strip()?.nativeElement;
      strip?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
    });
  }
  ngOnInit() {
    this.i.set(this.start());
  }
  protected go(d: number) {
    this.i.update((x) => Math.max(0, Math.min(this.items().length - 1, x + d)));
  }
}

/** Customer photos under the product photos: a row of thumbnails that opens the viewer. */
@Component({
  selector: "pc-customer-media-strip",
  imports: [Icon, PcLink, MediaThumb, CustomerMediaViewer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (signIn()) {
      <p class="mt-3 text-sm text-ink-soft"><svg [pcIcon]="Camera" class="mr-1 inline h-4 w-4" /> Customers shared photos of this product. <a [pcLink]="'/login?next=' + enc(path())" class="font-semibold text-peacock">Sign in to see them</a></p>
    } @else if (items().length && photosShown() > 0) {
      <section class="mt-4" aria-labelledby="cust-media-h" data-testid="customer-media">
        <h2 id="cust-media-h" class="mb-2 text-sm font-semibold">Customer photos and videos ({{ total() }})</h2>
        <div class="flex flex-wrap gap-2">
          @for (m of shown(); track m.url + "-" + k; let k = $index) {
            <pc-media-thumb [m]="m" (pick)="open.set(k)" [label]="'Customer ' + m.kind + ' ' + (k + 1) + ' from ' + m.author" thumbClass="h-16 w-16" />
          }
          @if (total() > shown().length) {
            <button type="button" (click)="open.set(shown().length)" class="flex h-16 w-16 items-center justify-center rounded-lg bg-ink/80 text-sm font-semibold text-white hover:bg-ink">+{{ total() - shown().length }}</button>
          }
        </div>
        @if (open() !== null) {
          <pc-customer-media-viewer [items]="items()" [start]="open()!" [total]="total()" [loadMore]="loadMore" (close)="open.set(null)" />
        }
      </section>
    }
  `,
})
export class CustomerMediaStrip {
  readonly slug = input.required<string>();
  protected readonly path = inject(RouteState).pathname;
  private readonly lists = inject(SiteService).lists;
  private readonly user = inject(SessionService).user;
  protected readonly Camera = Camera;
  protected readonly enc = encodeURIComponent;
  protected readonly photosShown = computed(() => this.lists().customer_photos_shown);
  protected readonly items = signal<CustomerMediaItem[]>([]);
  protected readonly total = signal(0);
  protected readonly signIn = signal(false);
  private page = 1;
  protected readonly open = signal<number | null>(null);
  protected readonly shown = computed(() => this.items().slice(0, this.photosShown()));
  private loading = false;

  constructor() {
    effect(() => {
      const slug = this.slug();
      this.user();
      api<{ items: CustomerMediaItem[]; total: number; sign_in_to_see?: boolean }>(`/api/catalog/products/${slug}/media`)
        .then((r) => { this.items.set(r.items); this.total.set(r.total); this.signIn.set(Boolean(r.sign_in_to_see)); this.page = 1; })
        .catch(quietly);
    });
  }

  protected readonly loadMore = () => {
    if (this.loading) return;
    this.loading = true;
    api<{ items: CustomerMediaItem[] }>(`/api/catalog/products/${this.slug()}/media`, { query: { page: this.page + 1 } })
      .then((r) => { this.items.update((x) => [...x, ...r.items]); this.page += 1; })
      .catch(quietly)
      .finally(() => { this.loading = false; });
  };
}

/* ---------------------------------------------------------------- write a review */

type Upload = ReviewMedia & { key: string; progress?: number };

/** A frame from the video as a poster (JPEG) and its length. Port of frameAndLength in components/video-editor.tsx. */
async function frameAndLength(file: File): Promise<{ poster: File | null; duration: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((ok, fail) => { video.onloadedmetadata = () => ok(); video.onerror = () => fail(new Error("unreadable")); });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.min(1, duration * 0.2);
    await new Promise<void>((ok) => { video.onseeked = () => ok(); setTimeout(ok, 3000); });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = canvas.width >= 200 && canvas.height >= 200 ? await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85)) : null;
    return { poster: blob ? new File([blob], "poster.jpg", { type: "image/jpeg" }) : null, duration };
  } catch {
    return { poster: null, duration: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

@Component({
  selector: "pc-review-form",
  imports: [Icon, ErrorNote, TextField, Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-4">
      <pc-error-note [message]="error()" />
      <fieldset>
        <legend class="mb-1 text-sm font-semibold">Overall rating</legend>
        <div class="flex items-center gap-3">
          <div class="flex gap-1" (mouseleave)="hover.set(0)">
            @for (n of [1, 2, 3, 4, 5]; track n) {
              <button type="button" (click)="rating.set(n)" (mouseenter)="hover.set(n)" [attr.aria-label]="n + ' star' + (n > 1 ? 's' : '') + ': ' + WORDS[n]" [attr.aria-pressed]="rating() === n">
                <svg [pcIcon]="Star" [class]="n <= shownStars() ? 'h-9 w-9 transition fill-marigold text-marigold' : 'h-9 w-9 transition text-line'" />
              </button>
            }
          </div>
          <span class="text-sm font-semibold text-ink-soft">{{ WORDS[shownStars()] }}</span>
        </div>
      </fieldset>
      @if (settings().photos || settings().videos) {
        <div>
          <p class="mb-1 text-sm font-semibold">Add photos or a video <span class="font-normal text-ink-faint">(optional)</span></p>
          <p class="mb-2 text-xs text-ink-faint">{{ allowance() }}. Shoppers find photos of the real product the most helpful.</p>
          <div class="flex flex-wrap gap-2">
            @for (m of media(); track m.key) {
              <div class="relative h-20 w-20 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                @if (m.kind === "video") {
                  <span class="flex h-full w-full items-center justify-center bg-ink/80 text-white">
                    @if (m.poster_url) {<img [src]="m.poster_url" alt="" class="h-full w-full object-cover" />} @else {<svg [pcIcon]="VideoIcon" class="h-7 w-7" />}
                  </span>
                } @else {
                  <img [src]="m.url" alt="" class="h-full w-full object-cover" />
                }
                @if (m.progress !== undefined) {
                  <span class="absolute inset-x-1 bottom-1 h-1.5 overflow-hidden rounded-full bg-white/70"><span class="block h-full bg-peacock" [style.width.%]="m.progress * 100"></span></span>
                } @else {
                  <button type="button" (click)="removeMedia(m.key)" aria-label="Remove" class="absolute right-0.5 top-0.5 rounded-full bg-white/90 p-0.5 shadow"><svg [pcIcon]="X" class="h-3.5 w-3.5" /></button>
                }
              </div>
            }
            @if (photos() < settings().max_photos || (settings().videos && videos() < 1)) {
              <label class="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-xs font-semibold text-peacock hover:border-peacock">
                <svg [pcIcon]="ImagePlus" class="h-6 w-6" /> Add
                <input type="file" [attr.accept]="accept()" multiple class="sr-only" (change)="pickFiles($event)" data-testid="review-media-input" />
              </label>
            }
          </div>
        </div>
      }
      <pc-text-field label="Headline" [(value)]="title" maxlength="120" placeholder="What's most important to know?" />
      <div>
        <label class="mb-1 block text-sm font-semibold" for="rv-body">Your review{{ settings().min_body_chars ? "" : " (optional)" }}</label>
        <textarea pcTextarea id="rv-body" [value]="body()" (input)="body.set($any($event.target).value)" maxlength="4000" rows="5" placeholder="What did you like or dislike? How did you use it?"></textarea>
        <p class="mt-0.5 text-right text-xs text-ink-faint">{{ body().length }}/4000</p>
      </div>
      @if (settings().guidelines) {<p class="rounded-lg bg-mist p-3 text-xs text-ink-soft">{{ settings().guidelines }}</p>}
      <button pcButton type="submit" [loading]="busy()" [disabled]="uploading()" class="self-start">{{ initial() ? "Update review" : "Submit review" }}</button>
    </form>
  `,
})
export class ReviewForm {
  readonly slug = input.required<string>();
  readonly initial = input<Mine | null>(null);
  readonly settings = input.required<ReviewSettingsPublic>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly WORDS = STAR_WORDS;
  protected readonly Star = Star;
  protected readonly X = X;
  protected readonly ImagePlus = ImagePlus;
  protected readonly VideoIcon = Video;
  protected readonly rating = signal(0);
  protected readonly hover = signal(0);
  protected readonly title = signal("");
  protected readonly body = signal("");
  protected readonly media = signal<Upload[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly photos = computed(() => this.media().filter((m) => m.kind === "image").length);
  protected readonly videos = computed(() => this.media().filter((m) => m.kind === "video").length);
  protected readonly uploading = computed(() => this.media().some((m) => m.progress !== undefined));
  protected readonly shownStars = computed(() => this.hover() || this.rating());
  protected readonly accept = computed(() => [this.settings().photos && "image/jpeg,image/png,image/webp", this.settings().videos && "video/mp4,video/webm"].filter(Boolean).join(","));
  protected readonly allowance = computed(() => {
    const s = this.settings();
    return `${s.photos ? `Up to ${s.max_photos} photos` : ""}${s.photos && s.videos ? " and " : ""}${s.videos ? `one video (${s.max_video_mb} MB)` : ""}`;
  });

  ngOnInit() {
    const i = this.initial();
    this.rating.set(i?.rating ?? 0);
    this.title.set(i?.title ?? "");
    this.body.set(i?.body ?? "");
    this.media.set((i?.media ?? []).map((m, k) => ({ ...m, key: `${k}-${m.url}` })));
  }

  protected removeMedia(key: string) {
    this.media.update((x) => x.filter((y) => y.key !== key));
  }

  protected pickFiles(e: Event) {
    const el = e.target as HTMLInputElement;
    void this.addFiles(el.files);
    el.value = "";
  }

  private async addFiles(files: FileList | null) {
    if (!files) return;
    const settings = this.settings();
    this.error.set(null);
    // counted once, like the reference (its counts come from the render the files were picked in)
    const videos = this.videos(), photos = this.photos();
    for (const file of Array.from(files)) {
      const isVideo = file.type.startsWith("video/");
      if (isVideo && (!settings.videos || videos >= 1)) { this.error.set(settings.videos ? "Add at most one video" : "Videos are not accepted"); continue; }
      if (!isVideo && photos >= settings.max_photos) { this.error.set(`Add at most ${settings.max_photos} photos`); continue; }
      if (isVideo && file.size > settings.max_video_mb * 1048576) { this.error.set(`Videos can be up to ${settings.max_video_mb} MB`); continue; }
      const key = `${Date.now()}-${file.name}`;
      const local = URL.createObjectURL(file);
      this.media.update((m) => [...m, { key, kind: isVideo ? "video" : "image", url: local, poster_url: "", progress: 0 }]);
      try {
        let poster_url = "";
        if (isVideo) {
          const { poster } = await frameAndLength(file);
          if (poster) poster_url = (await uploadWithProgress<{ url: string }>("/api/reviews/media", poster, () => {})).url;
        }
        const up = await uploadWithProgress<{ url: string; kind: "image" | "video" }>("/api/reviews/media", file, (f) =>
          this.media.update((m) => m.map((x) => (x.key === key ? { ...x, progress: f } : x))));
        this.media.update((m) => m.map((x) => (x.key === key ? { key, kind: up.kind, url: up.url, poster_url } : x)));
      } catch (x) {
        this.media.update((m) => m.filter((y) => y.key !== key));
        this.error.set(x instanceof ApiError ? x.message : "That file could not be uploaded");
      } finally {
        URL.revokeObjectURL(local);
      }
    }
  }

  protected async submit(e: Event) {
    e.preventDefault();
    const settings = this.settings();
    if (!this.rating()) return this.error.set("Choose a star rating");
    if (settings.min_body_chars && this.body().trim().length < settings.min_body_chars) return this.error.set(`Write at least ${settings.min_body_chars} characters`);
    if (this.uploading()) return this.error.set("Wait for the uploads to finish");
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ status: string; media_status: string; held_for_check: boolean }>(`/api/catalog/products/${this.slug()}/reviews`, {
        method: "PUT", body: { rating: this.rating(), title: this.title(), body: this.body(), media: this.media().map(({ kind, url, poster_url }) => ({ kind, url, poster_url })) },
      });
      this.toast.show(r.held_for_check ? "Thanks! Reviews with phone numbers, emails or links are checked before they appear."
        : r.status === "pending" ? "Thanks! Your review will appear after a quick check."
          : r.media_status === "pending" ? "Thanks! Your photos will appear after a quick check." : "Thanks for your review");
      this.done.emit();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save your review");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- report a review */

@Component({
  selector: "pc-report-review",
  imports: [Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="send($event)" class="flex flex-col gap-2">
      @for (r of reasonList(); track r[0]) {
        <label [class]="reason() === r[0] ? 'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm border-peacock bg-peacock-light' : 'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm border-line'">
          <input type="radio" name="rr" [checked]="reason() === r[0]" (change)="reason.set(r[0])" class="accent-peacock" /> {{ r[1] }}
        </label>
      }
      <textarea pcTextarea rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)" placeholder="Anything else? (optional)"></textarea>
      @if (error()) {<p class="text-sm text-vermilion">{{ error() }}</p>}
      <button pcButton type="submit" [loading]="busy()" class="self-start">Report review</button>
    </form>
  `,
})
export class ReportReview {
  readonly id = input.required<string>();
  readonly reasons = input.required<Record<string, string>>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly reasonList = computed(() => Object.entries(this.reasons()));
  protected readonly reason = signal("");
  protected readonly note = signal("");
  protected readonly error = signal("");
  protected readonly busy = signal(false);
  protected async send(e: Event) {
    e.preventDefault();
    if (!this.reason()) return this.error.set("Choose a reason");
    this.busy.set(true);
    try {
      await api(`/api/reviews/${this.id()}/report`, { method: "POST", body: { reason: this.reason(), note: this.note() } });
      this.toast.show("Thanks. Our team will check this review.");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not send the report");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- the reviews section */

@Component({
  selector: "article[pcReviewCard]",
  imports: [Icon, PcLink, Stars, MediaThumb],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the host is the reference's <article> (so "last:border-0" sees its siblings)
  host: { class: "border-b border-line pb-5 last:border-0", "data-testid": "review" },
  template: `
      <div class="flex items-center gap-2">
        <span class="flex h-8 w-8 items-center justify-center rounded-full bg-peacock-light text-sm font-semibold text-peacock">{{ r().author.slice(0, 1).toUpperCase() }}</span>
        <span class="font-semibold">{{ r().author }}</span>
        @if (r().mine) {<span class="rounded bg-marigold-light px-1.5 text-xs font-semibold">Your review</span>}
      </div>
      <div class="mt-1.5 flex flex-wrap items-center gap-2">
        <pc-stars [value]="r().rating" />
        @if (r().title) {<p class="font-semibold">{{ r().title }}</p>}
      </div>
      <p class="mt-0.5 text-xs text-ink-faint">
        Reviewed on {{ date(r().created_at) }}@if (r().verified) {<span class="ml-2 inline-flex items-center gap-0.5 font-semibold text-leaf"><svg [pcIcon]="BadgeCheck" class="h-3.5 w-3.5" /> Verified purchase</span>}
      </p>
      @if (r().body) {
        <p class="mt-2 whitespace-pre-line text-ink-soft">{{ long() && !more() ? r().body.slice(0, 400) + "…" : r().body }}@if (long()) {<button type="button" (click)="more.set(!more())" class="ml-1 text-sm font-semibold text-peacock">{{ more() ? "Show less" : "Read more" }}</button>}</p>
      }
      @if (r().media.length > 0) {
        <div class="mt-2 flex flex-wrap gap-2">
          @for (m of r().media; track m.url; let i = $index) {<pc-media-thumb [m]="m" (pick)="media.emit(i)" [label]="'Open ' + m.kind + ' ' + (i + 1) + ' of this review'" />}
        </div>
      }
      @if (r().seller_reply) {<p class="mt-2 rounded-lg bg-mist p-3 text-sm"><span class="font-semibold">Response from the seller:</span> {{ r().seller_reply }}</p>}
      <div class="mt-2 flex flex-wrap items-center gap-3 text-sm">
        @if (r().helpful_count > 0) {<span class="text-ink-faint">{{ r().helpful_count === 1 ? "One person" : r().helpful_count + " people" }} found this helpful</span>}
        @if (r().mine) {
          <button type="button" (click)="edit.emit()" class="flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="Pencil" class="h-3.5 w-3.5" /> Edit</button>
          <button type="button" (click)="remove.emit()" class="flex items-center gap-1 text-ink-faint hover:text-vermilion"><svg [pcIcon]="Trash2" class="h-3.5 w-3.5" /> Delete</button>
        } @else if (signedIn()) {
          <button type="button" (click)="vote.emit()" [attr.aria-pressed]="r().voted"
            [class]="r().voted ? 'flex items-center gap-1 rounded-full px-3 py-1 ring-1 bg-peacock text-white ring-peacock' : 'flex items-center gap-1 rounded-full px-3 py-1 ring-1 ring-line hover:bg-mist'">
            <svg [pcIcon]="ThumbsUp" class="h-3.5 w-3.5" /> Helpful
          </button>
          @if (r().reported) {<span class="text-xs text-ink-faint">Reported</span>}
          @else {<button type="button" (click)="report.emit()" class="flex items-center gap-1 text-ink-faint hover:text-vermilion"><svg [pcIcon]="Flag" class="h-3.5 w-3.5" /> Report</button>}
        } @else {
          <a [pcLink]="loginHref()" class="text-ink-faint hover:text-peacock">Sign in to mark this helpful</a>
        }
      </div>
  `,
})
export class ReviewCard {
  readonly r = input.required<Item>();
  readonly signedIn = input(false);
  readonly loginHref = input.required<string>();
  readonly vote = output<void>();
  readonly report = output<void>();
  readonly edit = output<void>();
  readonly remove = output<void>();
  readonly media = output<number>();
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly Pencil = Pencil;
  protected readonly Trash2 = Trash2;
  protected readonly ThumbsUp = ThumbsUp;
  protected readonly Flag = Flag;
  protected readonly date = date;
  protected readonly more = signal(false);
  protected readonly long = computed(() => this.r().body.length > 420);
}

@Component({
  selector: "pc-product-reviews",
  imports: [Icon, PcLink, Stars, MediaThumb, CustomerMediaViewer, ReviewForm, ReportReview, ReviewCard, Button, Modal, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().features.reviews && data(); as d) {
      <section class="rounded-xl bg-white p-4 sm:p-6" id="reviews" aria-labelledby="reviews-h">
        <h2 id="reviews-h" class="mb-4 text-2xl font-semibold">Customer reviews</h2>
        <div class="grid gap-8 lg:grid-cols-[300px_1fr]">
          <!-- left: score, bars, write -->
          <div class="flex flex-col gap-4">
            @if (d.rating_count > 0) {
              <div>
                <div class="flex items-center gap-2"><pc-stars [value]="d.rating_avg" size="h-5 w-5" /><span class="text-lg font-semibold">{{ d.rating_avg.toFixed(1) }} out of 5</span></div>
                <p class="mt-1 text-sm text-ink-faint">{{ d.rating_count.toLocaleString("en-IN") }} {{ d.rating_count === 1 ? "rating" : "ratings" }}</p>
                <div class="mt-3 flex flex-col gap-1.5">
                  @for (row of bars(); track row.s) {
                    <button type="button" [disabled]="!row.n" (click)="resetTo(() => star.set(row.active ? null : row.star))" [attr.aria-pressed]="row.active"
                      [class]="cx('group flex items-center gap-2 rounded px-1 text-sm', row.n ? 'hover:bg-mist' : 'cursor-default opacity-60', row.active && 'bg-peacock-light')">
                      <span class="w-12 text-left text-peacock group-hover:underline">{{ row.s }} star</span>
                      <span class="h-4 flex-1 overflow-hidden rounded bg-mist ring-1 ring-line"><span class="block h-full bg-marigold" [style.width.%]="(row.n / max()) * 100"></span></span>
                      <span class="w-10 text-right text-ink-faint">{{ row.pct }}%</span>
                    </button>
                  }
                </div>
              </div>
            } @else {
              <p class="text-ink-soft">No reviews yet. {{ d.settings.buyers_only ? "Customers who buy this can review it after delivery." : "Be the first to review it." }}</p>
            }
            <div class="border-t border-line pt-4">
              <p class="font-semibold">Review this product</p>
              <p class="mb-3 text-sm text-ink-soft">Share your thoughts with other customers</p>
              @if (!d.mine) {
                @if (d.can_review) {
                  <button pcButton variant="secondary" (click)="writing.set(true)" class="w-full">Write a review</button>
                } @else if (d.cannot_review_reason === "sign_in") {
                  <a [pcLink]="loginHref()" class="block rounded-lg border border-line px-4 py-2 text-center font-semibold text-peacock hover:bg-mist">Sign in to write a review</a>
                } @else if (d.cannot_review_reason === "not_purchased") {
                  <p class="text-sm text-ink-faint">{{ d.settings.buyers_only ? "Only customers who bought this product can review it, after it is delivered." : "You can review this product after you buy it." }}</p>
                }
              }
              @if (d.mine) {
                <div class="rounded-lg bg-mist p-3 text-sm">
                  <p class="font-semibold">You reviewed this product</p>
                  @if (d.mine.status === "pending") {<p class="text-ink-soft">Your review is waiting for a quick check.</p>}
                  @if (d.mine.status === "hidden") {<p class="text-vermilion">Your review was removed because it did not follow the review guidelines.</p>}
                  @if (d.mine.media_status === "pending" && d.mine.media.length > 0) {<p class="text-ink-soft">Your photos will appear after a check.</p>}
                  <div class="mt-2 flex gap-3">
                    <button type="button" (click)="writing.set(true)" class="font-semibold text-peacock">Edit</button>
                    <button type="button" (click)="remove()" class="text-ink-faint hover:text-vermilion">Delete</button>
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- right: what customers say, photos, filters, list -->
          <div class="flex min-w-0 flex-col gap-5">
            @if (d.summary || d.topics.length > 0) {
              <div>
                <h3 class="mb-1 text-lg font-semibold">Customers say</h3>
                @if (d.summary) {<p class="text-ink-soft">{{ d.summary }}</p>}
                @if (d.summary) {<p class="mt-1 text-xs text-ink-faint">Written by AI from the text of customer reviews</p>}
                @if (d.topics.length > 0) {
                  <div class="mt-3 flex flex-wrap gap-2" aria-label="Topics customers mention">
                    @for (t of d.topics; track t.name) {
                      <button type="button" (click)="resetTo(() => topic.set(topic() === t.name ? '' : t.name))" [attr.aria-pressed]="topic() === t.name"
                        [attr.title]="t.positive + ' positive, ' + t.negative + ' negative mentions'" [class]="topicCls(t)">
                        @if (t.tone !== "mixed") {<svg [pcIcon]="t.tone === 'negative' ? ThumbsDown : ThumbsUp" [class]="cx('h-3.5 w-3.5', topic() === t.name ? 'text-white' : t.tone === 'negative' ? 'text-vermilion' : 'text-leaf')" />}
                        {{ t.name }} <span [class]="topic() === t.name ? 'text-white/80' : 'text-ink-faint'">({{ t.count }})</span>
                      </button>
                    }
                  </div>
                }
              </div>
            }

            @if (d.media.length > 0) {
              <div>
                <h3 class="mb-2 text-lg font-semibold">Reviews with photos and videos</h3>
                <div class="scroll-x flex gap-2 overflow-x-auto">
                  @for (m of d.media; track m.url + "-" + i; let i = $index) {<pc-media-thumb [m]="m" (pick)="viewer.set({ items: d.media, start: i })" [label]="'Customer ' + m.kind + ' ' + (i + 1)" thumbClass="h-24 w-24" />}
                </div>
                @if (d.media_total > d.media.length) {<p class="mt-1 text-sm text-ink-faint">{{ d.media_total }} in all; open one to browse them.</p>}
              </div>
            }
            @if (d.media_hidden) {<p class="text-sm text-ink-soft"><svg [pcIcon]="Camera" class="mr-1 inline h-4 w-4" />{{ " " }}<a [pcLink]="loginHref()" class="font-semibold text-peacock">Sign in</a> to see customer photos and videos.</p>}

            @if (d.rating_count > 0) {
              <div class="flex flex-wrap items-center gap-2 border-y border-line py-3">
                <span class="text-sm font-semibold">Filter:</span>
                <button type="button" (click)="resetTo(() => onlyMedia.set(!onlyMedia()))" [attr.aria-pressed]="onlyMedia()" [disabled]="!d.with_media_count"
                  [class]="onlyMedia() ? 'rounded-full border px-3 py-1 text-sm disabled:opacity-50 border-peacock bg-peacock text-white' : 'rounded-full border px-3 py-1 text-sm disabled:opacity-50 border-line hover:bg-mist'">
                  With photos ({{ d.with_media_count }})
                </button>
                <button type="button" (click)="resetTo(() => onlyVerified.set(!onlyVerified()))" [attr.aria-pressed]="onlyVerified()"
                  [class]="onlyVerified() ? 'rounded-full border px-3 py-1 text-sm border-peacock bg-peacock text-white' : 'rounded-full border px-3 py-1 text-sm border-line hover:bg-mist'">
                  Verified purchase ({{ d.verified_count }})
                </button>
                <label class="sr-only" for="rv-star">Star rating</label>
                <select pcSelect id="rv-star" (change)="starPicked($event)" class="h-9 w-auto text-sm">
                  <option value="" [selected]="star() === null">All stars</option>
                  @for (s of [5, 4, 3, 2, 1]; track s) {<option [value]="s" [selected]="star() === s">{{ s }} star only</option>}
                </select>
                <label class="sr-only" for="rv-sort">Sort reviews</label>
                <select pcSelect id="rv-sort" (change)="sortPicked($event)" class="ml-auto h-9 w-auto text-sm">
                  @for (o of SORTS; track o[0]) {<option [value]="o[0]" [selected]="sort() === o[0]">{{ o[1] }}</option>}
                </select>
              </div>
            }
            @if (filtered()) {
              <p class="-mt-2 text-sm text-ink-soft">
                {{ d.total }} {{ d.total === 1 ? "review" : "reviews" }}{{ star() ? " with " + star() + " star" + (star()! > 1 ? "s" : "") : "" }}{{ topic() ? ' mentioning "' + topic() + '"' : "" }}<button type="button" (click)="clearFilters()" class="ml-2 font-semibold text-peacock">Clear filters</button>
              </p>
            }

            <div class="flex flex-col gap-5">
              @for (r of d.items; track r.id) {
                <article pcReviewCard [r]="r" [signedIn]="!!user()" [loginHref]="loginHref()" (vote)="vote(r)" (report)="reporting.set(r.id)"
                  (edit)="writing.set(true)" (remove)="remove()" (media)="openReviewMedia(r, $event)"></article>
              }
              @if (d.items.length === 0 && d.rating_count > 0) {<p class="text-ink-soft">{{ filtered() ? "No reviews match these filters." : "Customers have rated this product but not written a review yet." }}</p>}
            </div>
            @if (d.has_more) {<button pcButton variant="secondary" (click)="page.set(page() + 1)" class="self-start">Show more reviews</button>}
          </div>
        </div>
        <pc-modal [open]="writing()" (close)="writing.set(false)" [title]="d.mine ? 'Edit your review' : 'Write a review'" [wide]="true">
          @if (writing()) {<pc-review-form [slug]="slug()" [initial]="d.mine" [settings]="d.settings" (done)="writing.set(false); page.set(1); load()" />}
        </pc-modal>
        <pc-modal [open]="reporting() !== null" (close)="reporting.set(null)" title="Report this review">
          @if (reporting(); as id) {<pc-report-review [id]="id" [reasons]="d.settings.report_reasons" (done)="reporting.set(null); load()" />}
        </pc-modal>
        @if (viewer(); as v) {<pc-customer-media-viewer [items]="v.items" [start]="v.start" [total]="v.items.length" (close)="viewer.set(null)" />}
      </section>
    }
  `,
})
export class ProductReviews {
  readonly slug = input.required<string>();
  protected readonly site = inject(SiteService).site;
  protected readonly user = inject(SessionService).user;
  private readonly path = inject(RouteState).pathname;
  private readonly toast = inject(Toast);
  protected readonly cx = cx;
  protected readonly Camera = Camera;
  protected readonly ThumbsUp = ThumbsUp;
  protected readonly ThumbsDown = ThumbsDown;
  protected readonly SORTS = [["helpful", "Most helpful"], ["recent", "Most recent"], ["high", "Highest rating"], ["low", "Lowest rating"]] as const;
  protected readonly data = signal<R | null>(null);
  protected readonly sort = signal("helpful");
  protected readonly star = signal<number | null>(null);
  protected readonly onlyMedia = signal(false);
  protected readonly onlyVerified = signal(false);
  protected readonly topic = signal("");
  protected readonly page = signal(1);
  protected readonly writing = signal(false);
  protected readonly reporting = signal<string | null>(null);
  protected readonly viewer = signal<{ items: CustomerMediaItem[]; start: number } | null>(null);
  protected readonly loginHref = computed(() => `/login?next=${encodeURIComponent(`${this.path()}#reviews`)}`);
  protected readonly max = computed(() => Math.max(1, ...Object.values(this.data()?.distribution ?? { 0: 1 })));
  protected readonly filtered = computed(() => this.star() !== null || this.onlyMedia() || this.onlyVerified() || Boolean(this.topic()));
  protected readonly bars = computed(() => {
    const d = this.data()!;
    return Object.entries(d.distribution).sort((a, b) => Number(b[0]) - Number(a[0])).map(([s, n]) => ({
      s, n, star: Number(s), active: this.star() === Number(s), pct: d.rating_count ? Math.round((n / d.rating_count) * 100) : 0,
    }));
  });

  constructor() {
    effect(() => {
      // reload when any filter, the page or the signed-in shopper changes
      this.slug(); this.sort(); this.page(); this.star(); this.onlyMedia(); this.onlyVerified(); this.topic(); this.user();
      untracked(() => this.load());
    });
  }

  load(): void {
    const page = this.page();
    api<R>(`/api/catalog/products/${this.slug()}/reviews`, {
      query: { sort: this.sort(), page, star: this.star() ?? undefined, media: this.onlyMedia() || undefined, verified: this.onlyVerified() || undefined, topic: this.topic() || undefined },
    }).then((d) => this.data.update((prev) => (page > 1 && prev ? { ...d, items: [...prev.items, ...d.items] } : d))).catch(quietly);
  }

  protected resetTo(fn: () => void) {
    this.page.set(1);
    fn();
  }
  protected clearFilters() {
    this.resetTo(() => { this.star.set(null); this.onlyMedia.set(false); this.onlyVerified.set(false); this.topic.set(""); });
  }
  protected starPicked(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    this.resetTo(() => this.star.set(v ? Number(v) : null));
  }
  protected sortPicked(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    this.resetTo(() => this.sort.set(v));
  }
  protected topicCls(t: Topic) {
    const active = this.topic() === t.name;
    return cx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm",
      active ? "border-peacock bg-peacock text-white" : t.tone === "positive" ? "border-leaf/40 bg-leaf-light text-ink" : t.tone === "negative" ? "border-vermilion/30 bg-vermilion-light text-ink" : "border-line bg-white");
  }

  protected async vote(r: Item) {
    try {
      const res = await api<{ voted: boolean; helpful_count: number }>(`/api/reviews/${r.id}/helpful`, { method: "POST" });
      this.data.update((d) => d && { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, voted: res.voted, helpful_count: res.helpful_count } : x)) });
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not record your vote", "error");
    }
  }
  protected async remove() {
    if (!confirm("Delete your review? This cannot be undone.")) return;
    try {
      await api(`/api/catalog/products/${this.slug()}/reviews`, { method: "DELETE" });
      this.toast.show("Your review was deleted");
      this.page.set(1);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not delete", "error");
    }
  }
  protected openReviewMedia(r: Item, i: number) {
    this.viewer.set({
      items: r.media.map((m) => ({ ...m, review_id: r.id, rating: r.rating, title: r.title, body: r.body, author: r.author, verified: r.verified, created_at: r.created_at })),
      start: i,
    });
  }
}
