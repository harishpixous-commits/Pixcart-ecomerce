/*
 * Questions and answers on the product page. Anyone can read; signed-in shoppers ask, answer, vote "helpful" and report.
 * The seller's answer comes first; verified buyers are marked. Switched on or off in Admin → Product page.
 * Port of components/qa.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { BadgeCheck, Flag, MessageCircleQuestion, Search, Store, ThumbsUp } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { date } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, Select, Textarea, Toast } from "../../shared/ui/ui";

type Answer = { id: string; text: string; author: string; role: "seller" | "buyer" | "customer" | "staff"; role_label: string; helpful_count: number; voted: boolean; created_at: string };
type Question = { id: string; text: string; author: string; created_at: string; answer_count: number; answers: Answer[] };
type QA = { enabled: boolean; items: Question[]; total: number; page: number; has_more: boolean; can_ask?: boolean; buyers_answer_only?: boolean };

@Component({
  selector: "pc-answer-form",
  imports: [Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="send($event)" class="mt-2 flex flex-col gap-2">
      <textarea pcTextarea rows="2" maxlength="1000" [value]="text()" (input)="text.set($any($event.target).value)" placeholder="Share what you know about this product" aria-label="Your answer"></textarea>
      @if (error()) {<p class="text-sm text-vermilion">{{ error() }}</p>}
      <button pcButton type="submit" size="sm" [loading]="busy()" class="self-start">Post answer</button>
    </form>
  `,
})
export class AnswerForm {
  readonly qid = input.required<string>();
  readonly done = output<boolean>();
  protected readonly text = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal("");
  protected async send(e: Event) {
    e.preventDefault();
    if (this.text().trim().length < 2) return this.error.set("Write a short answer");
    this.busy.set(true);
    this.error.set("");
    try {
      const r = await api<{ status: string }>(`/api/questions/${this.qid()}/answers`, { method: "POST", body: { text: this.text() } });
      this.text.set("");
      this.done.emit(r.status === "pending");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not post your answer");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-product-questions",
  imports: [Icon, PcLink, AnswerForm, Button, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (data(); as d) {
      @if (d.enabled) {
        <section id="questions" class="scroll-mt-40 rounded-xl bg-white p-4 sm:p-6" aria-labelledby="qa-h" data-testid="questions">
          <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="qa-h" class="text-2xl font-semibold">Questions and answers</h2>
              <p class="text-sm text-ink-soft">{{ d.total ? d.total + " question" + (d.total === 1 ? "" : "s") + " about this product" : "Have a question? Ask the seller and buyers." }}</p>
            </div>
            <form (submit)="search($event)" class="flex w-full max-w-sm items-center gap-2 sm:w-auto">
              <label for="qa-search" class="sr-only">Search questions</label>
              <span class="relative flex-1">
                <svg [pcIcon]="Search" class="absolute left-2.5 top-2.5 h-4 w-4 text-ink-faint" />
                <input id="qa-search" [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search questions and answers" class="h-9 w-full rounded-lg border border-line pl-8 pr-2 text-sm" />
              </span>
              <select pcSelect (change)="sortPicked($event)" class="h-9 w-auto text-sm" aria-label="Sort questions">
                <option value="helpful" [selected]="sort() === 'helpful'">Most answered</option>
                <option value="recent" [selected]="sort() === 'recent'">Newest</option>
              </select>
            </form>
          </div>

          <div class="mb-4 rounded-lg bg-mist p-3">
            @if (user()) {
              <form (submit)="ask($event)" class="flex flex-col gap-2">
                <label for="qa-ask" class="flex items-center gap-1.5 font-semibold"><svg [pcIcon]="MessageCircleQuestion" class="h-4 w-4 text-peacock" /> Ask a question about {{ title().length > 60 ? "this product" : title() }}</label>
                <textarea pcTextarea id="qa-ask" rows="2" maxlength="500" [value]="asking()" (input)="asking.set($any($event.target).value)" placeholder="e.g. Is it suitable for daily use? What is the warranty?"></textarea>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="text-xs text-ink-faint">The seller and customers who bought it can answer. Please do not share phone numbers or links.</p>
                  <button pcButton type="submit" size="sm" [loading]="busy()">Post question</button>
                </div>
                @if (askError()) {<p class="text-sm text-vermilion">{{ askError() }}</p>}
              </form>
            } @else {
              <p class="text-sm"><a [pcLink]="login()" class="font-semibold text-peacock">Sign in</a> to ask a question or answer one.</p>
            }
          </div>

          @if (d.items.length === 0) {
            <p class="text-ink-soft">{{ query() ? 'No questions mention "' + query() + '".' : "No questions yet. Be the first to ask." }}</p>
          } @else {
            <ul class="flex flex-col divide-y divide-line">
              @for (qn of d.items; track qn.id) {
                <li class="py-4 first:pt-0" data-testid="question">
                  <p class="flex gap-2"><span class="font-semibold text-peacock">Q:</span><span class="font-semibold">{{ qn.text }}</span></p>
                  <p class="ml-6 text-xs text-ink-faint">Asked by {{ qn.author }} on {{ date(qn.created_at) }}</p>
                  <div class="ml-6 mt-2 flex flex-col gap-3">
                    @for (a of qn.answers; track a.id) {
                      <div class="flex gap-2">
                        <span class="font-semibold text-leaf">A:</span>
                        <div class="min-w-0 flex-1">
                          <p class="whitespace-pre-line text-ink-soft">{{ a.text }}</p>
                          <p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                            <span [class]="cx('inline-flex items-center gap-1 font-semibold', a.role === 'seller' ? 'text-peacock' : a.role === 'buyer' ? 'text-leaf' : '')">
                              @if (a.role === "seller") {<svg [pcIcon]="Store" class="h-3.5 w-3.5" />} @else if (a.role === "buyer") {<svg [pcIcon]="BadgeCheck" class="h-3.5 w-3.5" />}
                              {{ a.author }} · {{ a.role_label }}
                            </span>
                            <span>{{ date(a.created_at) }}</span>
                            @if (user()) {
                              <button type="button" (click)="vote(a)" [attr.aria-pressed]="a.voted" [class]="a.voted ? 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 bg-peacock text-white ring-peacock' : 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-line hover:bg-mist'">
                                <svg [pcIcon]="ThumbsUp" class="h-3 w-3" /> Helpful{{ a.helpful_count ? " (" + a.helpful_count + ")" : "" }}
                              </button>
                            } @else if (a.helpful_count > 0) {<span>{{ a.helpful_count }} found this helpful</span>}
                            @if (user()) {<button type="button" (click)="report('answer', a.id)" class="inline-flex items-center gap-1 hover:text-vermilion"><svg [pcIcon]="Flag" class="h-3 w-3" /> Report</button>}
                          </p>
                        </div>
                      </div>
                    }
                    @if (qn.answers.length === 0) {<p class="text-sm text-ink-faint">No answers yet.</p>}
                    <div class="flex flex-wrap gap-3 text-sm">
                      @if (user()) {
                        @if (answering() !== qn.id) {<button type="button" (click)="answering.set(qn.id)" class="font-semibold text-peacock hover:underline">Answer this question</button>}
                      } @else {<a [pcLink]="login()" class="font-semibold text-peacock hover:underline">Sign in to answer</a>}
                      @if (user()) {<button type="button" (click)="report('question', qn.id)" class="inline-flex items-center gap-1 text-ink-faint hover:text-vermilion"><svg [pcIcon]="Flag" class="h-3.5 w-3.5" /> Report question</button>}
                    </div>
                    @if (answering() === qn.id) {<pc-answer-form [qid]="qn.id" (done)="answered($event)" />}
                  </div>
                </li>
              }
            </ul>
          }
          @if (d.has_more) {<button pcButton variant="secondary" (click)="page.set(page() + 1)" class="mt-3">See more questions</button>}
          @if (d.buyers_answer_only) {<p class="mt-3 text-xs text-ink-faint">Only the seller and customers who bought this product can answer.</p>}
        </section>
      }
    }
  `,
})
export class ProductQuestions {
  readonly slug = input.required<string>();
  readonly title = input.required<string>();
  protected readonly user = inject(SessionService).user;
  private readonly path = inject(RouteState).pathname;
  private readonly toast = inject(Toast);
  protected readonly cx = cx;
  protected readonly date = date;
  protected readonly Search = Search;
  protected readonly MessageCircleQuestion = MessageCircleQuestion;
  protected readonly Store = Store;
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly ThumbsUp = ThumbsUp;
  protected readonly Flag = Flag;
  protected readonly data = signal<QA | null>(null);
  protected readonly q = signal("");
  protected readonly query = signal("");
  protected readonly sort = signal<"helpful" | "recent">("helpful");
  protected readonly page = signal(1);
  protected readonly asking = signal("");
  protected readonly askError = signal("");
  protected readonly busy = signal(false);
  protected readonly answering = signal<string | null>(null);
  protected readonly login = computed(() => `/login?next=${encodeURIComponent(`${this.path()}#questions`)}`);

  constructor() {
    effect(() => {
      this.slug(); this.query(); this.sort(); this.page(); this.user();
      untracked(() => this.load());
    });
  }

  private load(): void {
    const page = this.page();
    api<QA>(`/api/catalog/products/${this.slug()}/questions`, { query: { q: this.query() || undefined, sort: this.sort(), page } })
      .then((d) => this.data.update((prev) => (page > 1 && prev ? { ...d, items: [...prev.items, ...d.items] } : d))).catch(() => {});
  }

  protected search(e: Event) {
    e.preventDefault();
    this.page.set(1);
    this.query.set(this.q().trim());
  }
  protected sortPicked(e: Event) {
    this.page.set(1);
    this.sort.set((e.target as HTMLSelectElement).value as "helpful" | "recent");
  }

  protected async ask(e: Event) {
    e.preventDefault();
    if (this.asking().trim().length < 10) return this.askError.set("Questions are at least 10 characters");
    this.busy.set(true);
    this.askError.set("");
    try {
      const r = await api<{ status: string }>(`/api/catalog/products/${this.slug()}/questions`, { method: "POST", body: { text: this.asking() } });
      this.asking.set("");
      this.toast.show(r.status === "pending" ? "Thanks! Your question will appear after a quick check." : "Your question is posted. We will tell you when someone answers.");
      this.page.set(1);
      this.load();
    } catch (x) {
      this.askError.set(x instanceof ApiError ? x.message : "Could not post your question");
    } finally {
      this.busy.set(false);
    }
  }
  protected async vote(a: Answer) {
    try {
      const r = await api<{ voted: boolean; helpful_count: number }>(`/api/answers/${a.id}/helpful`, { method: "POST" });
      this.data.update((d) => d && { ...d, items: d.items.map((x) => ({ ...x, answers: x.answers.map((y) => (y.id === a.id ? { ...y, voted: r.voted, helpful_count: r.helpful_count } : y)) })) });
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not record your vote", "error");
    }
  }
  protected async report(kind: "question" | "answer", id: string) {
    try {
      const r = await api<{ already: boolean }>("/api/qa/report", { method: "POST", body: { kind, id } });
      this.toast.show(r.already ? "You have already reported this. Our team will check it." : "Thanks. Our team will check it.");
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not report", "error");
    }
  }
  protected answered(pending: boolean) {
    this.answering.set(null);
    this.toast.show(pending ? "Thanks! Your answer will appear after a quick check." : "Your answer is posted.");
    this.load();
  }
}
