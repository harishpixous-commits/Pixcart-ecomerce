/* Reviews of the seller's products: rating summary, topics, filters, replies (with an AI draft) and reports to the marketplace. Port of frontend/src/app/seller/reviews/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import { BadgeCheck, ExternalLink, Flag, Play, ThumbsDown, ThumbsUp } from "lucide-angular";
import { ApiError, api, latestOnly } from "../../core/api";
import { date } from "../../core/format";
import { SiteService } from "../../core/site";
import type { ReviewMedia } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { AiBadge, AiDraftButton, type AiRun } from "../../shared/portal/ai";
import { Stars } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, Input, Modal, Pagination, Pill, Textarea, Toast } from "../../shared/ui/ui";

type R = {
  id: string; product: string; slug: string; rating: number; title: string; body: string; reply: string; status: string; verified: boolean;
  media: ReviewMedia[]; media_status: string; helpful_count: number; reported: boolean; at: string;
};
type Topic = { name: string; count: number; positive: number; negative: number; positive_pct: number; tone: string };
type D = {
  rating_avg: number; rating_count: number; distribution: Record<string, number>; topics: Topic[]; can_report: boolean;
  report_reasons: Record<string, string>; items: R[]; total: number; has_more: boolean;
};

@Component({
  selector: "pc-seller-reviews-page",
  imports: [PageHeader, AiBadge, AiDraftButton, Stars, Icon, PageLoader, Button, EmptyState, Input, Modal, Pagination, Pill, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div>
        <pc-page-header title="Reviews" sub="Reply politely and publicly: customers read replies before they buy. You cannot remove reviews, but you can ask the marketplace to check one." />
        <div class="mb-4 grid gap-4 lg:grid-cols-[320px_1fr]">
          <section class="rounded-xl bg-white p-4">
            <div class="flex items-center gap-3">
              <p class="font-display text-4xl font-bold">{{ d()!.rating_avg.toFixed(1) }}</p>
              <div><pc-stars [value]="d()!.rating_avg" /><p class="text-sm text-ink-soft">Store rating from {{ d()!.rating_count }} reviews</p></div>
            </div>
            <div class="mt-3 flex flex-col gap-1">
              @for (s of distribution(); track s[0]) {
                <button type="button" (click)="pickRating(+s[0])"
                  [class]="'flex items-center gap-2 rounded px-1 text-sm hover:bg-mist' + (rating() === +s[0] ? ' bg-peacock-light' : '')">
                  <span class="w-10 text-left">{{ s[0] }} star</span>
                  <span class="h-2.5 flex-1 overflow-hidden rounded-full bg-mist"><span class="block h-full bg-marigold" [style.width.%]="(s[1] / max()) * 100"></span></span>
                  <span class="w-8 text-right text-ink-faint">{{ s[1] }}</span>
                </button>
              }
            </div>
          </section>
          <section class="rounded-xl bg-white p-4">
            <h2 class="mb-1 font-semibold">What customers talk about</h2>
            <p class="mb-3 text-sm text-ink-soft">Across all your products. Fix what customers complain about most; it is the fastest way to raise your rating.</p>
            @if (d()!.topics.length === 0) {
              <p class="text-sm text-ink-faint">Topics appear once a few reviews mention the same thing.</p>
            } @else {
              <div class="flex flex-wrap gap-2">
                @for (t of d()!.topics; track t.name) {
                  <span [class]="'flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm ' + (t.tone === 'positive' ? 'border-leaf/40 bg-leaf-light' : t.tone === 'negative' ? 'border-vermilion/30 bg-vermilion-light' : 'border-line')">
                    @if (t.tone === "negative") {<svg [pcIcon]="ThumbsDown" class="h-3.5 w-3.5 text-vermilion" />} @else {<svg [pcIcon]="ThumbsUp" class="h-3.5 w-3.5 text-leaf" />}
                    {{ t.name }} · {{ t.count }} mentions · {{ t.positive_pct }}% positive
                  </span>
                }
              </div>
            }
          </section>
        </div>

        <div class="mb-3 flex flex-wrap items-center gap-2">
          <input pcInput placeholder="Product or review text" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="max-w-xs" aria-label="Search reviews" />
          <button type="button" (click)="unanswered.set(!unanswered()); page.set(1)" [attr.aria-pressed]="unanswered()" [class]="unanswered() ? 'rounded-full px-3 py-1 text-sm bg-peacock text-white' : 'rounded-full px-3 py-1 text-sm bg-white ring-1 ring-line'">Not replied yet</button>
          <button type="button" (click)="media.set(!media()); page.set(1)" [attr.aria-pressed]="media()" [class]="media() ? 'rounded-full px-3 py-1 text-sm bg-peacock text-white' : 'rounded-full px-3 py-1 text-sm bg-white ring-1 ring-line'">With photos</button>
          @if (rating()) {<button type="button" (click)="rating.set(null)" class="rounded-full bg-peacock px-3 py-1 text-sm text-white">{{ rating() }} star ✕</button>}
        </div>

        @if (d()!.items.length === 0) {
          <pc-empty-state title="No reviews here" body="Reviews appear after customers receive their orders." [hasAction]="false" />
        } @else {
          <div class="flex flex-col gap-3">
            @for (r of d()!.items; track r.id) {
              <section class="rounded-xl bg-white p-4">
                <div class="flex flex-wrap items-center gap-2">
                  <pc-stars [value]="r.rating" />
                  <p class="font-semibold">{{ r.title }}</p>
                  @if (r.verified) {<span class="flex items-center gap-0.5 text-xs font-semibold text-leaf"><svg [pcIcon]="BadgeCheck" class="h-3.5 w-3.5" /> Verified purchase</span>}
                  @if (r.status === "pending") {<pc-pill tone="amber">Waiting for a check</pc-pill>}
                  @if (r.status === "hidden") {<pc-pill tone="red">Removed by the marketplace</pc-pill>}
                  @if (r.reported) {<pc-pill>Reported by you</pc-pill>}
                </div>
                <p class="text-sm text-ink-faint">
                  <a [href]="'/p/' + r.slug + '#reviews'" target="_blank" rel="noopener noreferrer" class="hover:text-peacock">{{ r.product }} <svg [pcIcon]="ExternalLink" class="inline h-3 w-3" /></a>, {{ date(r.at) }} · {{ r.helpful_count }} found it helpful
                </p>
                @if (r.body) {<p class="mt-1 whitespace-pre-line">{{ r.body }}</p>}
                @if (r.media.length > 0) {
                  <div class="mt-2 flex flex-wrap gap-2">
                    @for (m of r.media; track m.url) {
                      <a [href]="m.url" target="_blank" rel="noopener noreferrer" class="relative block h-16 w-16 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                        <img [src]="m.kind === 'video' ? m.poster_url || '' : m.url" alt="" class="h-full w-full object-cover" />
                        @if (m.kind === "video") {<svg [pcIcon]="Play" class="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 fill-white text-white" />}
                      </a>
                    }
                    @if (r.media_status === "pending") {<span class="self-center text-xs text-ink-faint">Photos waiting for a check</span>}
                  </div>
                }
                @if (r.reply && open() !== r.id) {<p class="mt-2 rounded-lg bg-mist p-2 text-sm"><strong>Your reply:</strong> {{ r.reply }}</p>}
                @if (open() === r.id) {
                  <div class="mt-2 flex flex-col gap-2">
                    @if (site().features.ai) {<pc-ai-draft-button base="/api/seller/ai" task="review_reply" [subjectId]="r.id" label="Draft reply with AI" (draft)="onDraft(r, $event)" />}
                    @if (runs()[r.id]; as run) {<p class="flex items-center gap-2 text-xs text-ink-faint"><pc-ai-badge [mode]="run.mode" /> Check the draft before saving.</p>}
                    <textarea pcTextarea [value]="draft()[r.id] ?? r.reply" (input)="setDraft(r.id, $any($event.target).value)" maxlength="2000" aria-label="Reply"></textarea>
                    <div class="flex gap-2">
                      <button pcButton size="sm" (click)="saveReply(r)">Save reply</button>
                      <button pcButton size="sm" variant="ghost" (click)="open.set(null)">Cancel</button>
                    </div>
                  </div>
                } @else {
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button pcButton size="sm" variant="ghost" (click)="open.set(r.id)">{{ r.reply ? "Edit reply" : "Reply" }}</button>
                    @if (d()!.can_report && !r.reported && r.status === "published") {
                      <button pcButton size="sm" variant="ghost" (click)="startReport(r)"><svg [pcIcon]="Flag" class="h-4 w-4" /> Ask the marketplace to check</button>
                    }
                  </div>
                }
              </section>
            }
          </div>
        }
        <pc-pagination [page]="page()" [pageSize]="20" [total]="d()!.total" (pageChange)="page.set($event)" />
        <pc-modal [open]="reporting() !== null" (close)="reporting.set(null)" title="Ask the marketplace to check this review">
          <form (submit)="report($event)" class="flex flex-col gap-2">
            <p class="text-sm text-ink-soft">Use this for abuse, personal details, reviews of a different product or fake reviews. Low ratings alone are not a reason; reply to them instead.</p>
            @for (k of reasons(); track k[0]) {
              <label [class]="'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ' + (reason() === k[0] ? 'border-peacock bg-peacock-light' : 'border-line')">
                <input type="radio" name="sr" [checked]="reason() === k[0]" (change)="reason.set(k[0])" class="accent-peacock" /> {{ k[1] }}
              </label>
            }
            <textarea pcTextarea rows="2" maxlength="500" [value]="note()" (input)="note.set($any($event.target).value)" placeholder="What should the team look at?" aria-label="Note"></textarea>
            <button pcButton type="submit" [disabled]="!reason()" class="self-start">Send</button>
          </form>
        </pc-modal>
      </div>
    }
  `,
})
export class SellerReviewsPage {
  private readonly toast = inject(Toast);
  protected readonly site = inject(SiteService).site;
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly ExternalLink = ExternalLink;
  protected readonly Flag = Flag;
  protected readonly Play = Play;
  protected readonly ThumbsDown = ThumbsDown;
  protected readonly ThumbsUp = ThumbsUp;
  protected readonly date = date;
  protected readonly d = signal<D | null>(null);
  protected readonly rating = signal<number | null>(null);
  protected readonly unanswered = signal(false);
  protected readonly media = signal(false);
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly draft = signal<Record<string, string>>({});
  protected readonly open = signal<string | null>(null);
  protected readonly runs = signal<Record<string, AiRun>>({});
  protected readonly reporting = signal<R | null>(null);
  protected readonly reason = signal("");
  protected readonly note = signal("");
  private readonly track = latestOnly();
  protected readonly max = computed(() => Math.max(1, ...Object.values(this.d()?.distribution ?? {})));
  protected readonly distribution = computed(() => Object.entries(this.d()?.distribution ?? {}).sort((a, b) => Number(b[0]) - Number(a[0])));
  protected readonly reasons = computed(() => Object.entries(this.d()?.report_reasons ?? {}));

  constructor() {
    effect((onCleanup) => {
      const query = { page: this.page(), rating: this.rating() ?? undefined, unanswered: this.unanswered() || undefined, media: this.media() || undefined, q: this.q() };
      const t = setTimeout(() => untracked(() => this.load(query)), query.q ? 250 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  private lastQuery: Record<string, string | number | boolean | undefined> = {};
  private load(query = this.lastQuery): void {
    this.lastQuery = query;
    void this.track(api<D>("/api/seller/reviews", { query }), (d) => this.d.set(d));
  }

  protected pickRating(s: number): void {
    this.rating.set(this.rating() === s ? null : s);
    this.page.set(1);
  }

  protected setDraft(id: string, v: string): void {
    this.draft.update((d) => ({ ...d, [id]: v }));
  }

  protected onDraft(r: R, run: AiRun): void {
    this.runs.update((x) => ({ ...x, [r.id]: run }));
    this.setDraft(r.id, run.output.text ?? "");
  }

  protected async saveReply(r: R): Promise<void> {
    await api(`/api/seller/reviews/${r.id}/reply`, { method: "PUT", body: { reply: this.draft()[r.id] ?? r.reply, ai_run_id: this.runs()[r.id]?.id } });
    this.toast.show("Reply saved");
    this.open.set(null);
    this.load();
  }

  protected startReport(r: R): void {
    this.reporting.set(r);
    this.reason.set("");
    this.note.set("");
  }

  protected async report(e: Event): Promise<void> {
    e.preventDefault();
    const reporting = this.reporting();
    if (!reporting || !this.reason()) return;
    try {
      await api(`/api/seller/reviews/${reporting.id}/report`, { method: "POST", body: { reason: this.reason(), note: this.note() } });
      this.toast.show("Sent to the marketplace team");
      this.reporting.set(null);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not send", "error");
    }
  }
}
