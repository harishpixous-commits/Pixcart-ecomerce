/* Questions shoppers asked on the seller's product pages, and the seller's answers. Port of frontend/src/app/seller/questions/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { MessageCircleQuestion, Store } from "lucide-angular";
import { ApiError, api, latestOnly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Pagination, Pill, Textarea, Toast } from "../../shared/ui/ui";

type Answer = { id: string; text: string; role: string; role_label: string; status: string; created_at: string };
type Question = { id: string; text: string; product: string; slug: string; created_at: string; answers: Answer[]; answered_by_you: boolean };
type Data = { items: Question[]; total: number; page: number; unanswered: number };

@Component({
  selector: "pc-seller-questions-page",
  imports: [PageHeader, Tabs, Icon, PageLoader, Button, EmptyState, ErrorNote, Pagination, Pill, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Customer questions" sub="Questions shoppers ask on your product pages. Your answer shows first, marked as the seller's. Answer quickly: unanswered questions cost sales." />
      <pc-tabs [value]="tab()" (valueChange)="setTab($event)" [items]="[{ value: 'waiting', label: 'Waiting for your answer', count: d()?.unanswered }, { value: 'all', label: 'All questions' }]" />
      <pc-error-note [message]="error()" />
      @if (!d()) {
        @if (!error()) {<pc-page-loader />}
      } @else if (d()!.items.length === 0) {
        <pc-empty-state [title]="tab() === 'waiting' ? 'All caught up' : 'No questions yet'" [body]="tab() === 'waiting' ? 'Every question on your products has your answer.' : 'When shoppers ask about your products, the questions show up here.'" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (q of d()!.items; track q.id) {
            <section class="rounded-xl bg-white p-4" data-testid="seller-question">
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <a [href]="'/p/' + q.slug + '#questions'" target="_blank" rel="noreferrer" class="font-semibold text-peacock hover:underline">{{ q.product }}</a>
                <span class="ml-auto text-xs text-ink-faint">{{ dateTime(q.created_at) }}</span>
              </div>
              <p class="mt-2 flex gap-2 font-medium"><svg [pcIcon]="MessageCircleQuestion" class="mt-0.5 h-5 w-5 shrink-0 text-peacock" /> {{ q.text }}</p>
              @if (q.answers.length > 0) {
                <ul class="mt-2 flex flex-col gap-2 border-l-2 border-line pl-4">
                  @for (a of q.answers; track a.id) {
                    <li class="text-sm">
                      <p class="whitespace-pre-line">{{ a.text }}</p>
                      <p class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                        @if (a.role === "seller") {<span class="inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="Store" class="h-3.5 w-3.5" /> You</span>} @else {<ng-container>{{ a.role_label }}</ng-container>}
                        · {{ dateTime(a.created_at) }}
                        @if (a.status === "pending") {<pc-pill tone="amber">Being checked</pc-pill>}
                      </p>
                    </li>
                  }
                </ul>
              }
              @if (!q.answered_by_you || open()[q.id]) {
                <div class="mt-3 flex flex-col gap-2">
                  <textarea pcTextarea rows="2" maxlength="1000" [value]="draft()[q.id] ?? ''" (input)="setDraft(q.id, $any($event.target).value)"
                    placeholder="Write a clear, helpful answer. Do not share phone numbers, emails or links." [attr.aria-label]="'Answer: ' + q.text"></textarea>
                  <div class="flex flex-wrap items-center gap-2">
                    <button pcButton size="sm" (click)="send(q)" [loading]="busy() === q.id" [disabled]="(draft()[q.id] ?? '').trim().length < 2">Post answer</button>
                    @if (q.answered_by_you) {<button pcButton size="sm" variant="ghost" (click)="setOpen(q.id, false)">Cancel</button>}
                    <span [class]="(draft()[q.id] ?? '').length > 900 ? 'ml-auto text-xs text-vermilion' : 'ml-auto text-xs text-ink-faint'">{{ (draft()[q.id] ?? "").length }}/1000</span>
                  </div>
                </div>
              } @else {
                <button pcButton size="sm" variant="ghost" class="mt-2" (click)="setOpen(q.id, true)">Add another answer</button>
              }
            </section>
          }
        </div>
      }
      @if (d()) {<pc-pagination [page]="page()" [pageSize]="20" [total]="d()!.total" (pageChange)="page.set($event)" />}
    </div>
  `,
})
export class SellerQuestionsPage {
  private readonly toast = inject(Toast);
  protected readonly MessageCircleQuestion = MessageCircleQuestion;
  protected readonly Store = Store;
  protected readonly dateTime = dateTime;
  protected readonly tab = signal("waiting");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly draft = signal<Record<string, string | undefined>>({});
  protected readonly open = signal<Record<string, boolean>>({});
  protected readonly busy = signal<string | null>(null);
  private readonly track = latestOnly();

  constructor() {
    effect(() => {
      const tab = this.tab();
      const page = this.page();
      untracked(() => this.load(tab, page));
    });
  }

  private load(tab = this.tab(), page = this.page()): void {
    this.track(api<Data>("/api/seller/questions", { query: { unanswered: tab === "waiting" ? "true" : undefined, page } }), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load questions"));
  }

  protected setTab(v: string): void {
    this.tab.set(v);
    this.page.set(1);
  }

  protected setDraft(id: string, v: string): void {
    this.draft.update((d) => ({ ...d, [id]: v }));
  }

  protected setOpen(id: string, v: boolean): void {
    this.open.update((o) => ({ ...o, [id]: v }));
  }

  protected async send(q: Question): Promise<void> {
    const text = (this.draft()[q.id] ?? "").trim();
    if (text.length < 2) return;
    this.busy.set(q.id);
    try {
      const out = await api<{ status: string }>(`/api/seller/questions/${q.id}/answer`, { method: "POST", body: { text } });
      this.toast.show(out.status === "pending" ? "Answer sent. It appears after a quick check." : "Answer posted on the product page");
      this.setDraft(q.id, "");
      this.setOpen(q.id, false);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not post the answer", "error");
    } finally {
      this.busy.set(null);
    }
  }
}
