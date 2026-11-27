/* One support request: the conversation, a reply box and "My issue is solved". Port of frontend/src/app/(shop)/support/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { map } from "rxjs";
import { ApiError, api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { SiteService } from "../../core/site";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Pill, Textarea } from "../../shared/ui/ui";

type T = {
  id: string; number: string; subject: string; status: string; category_label: string; order_id: string | null; is_grievance: boolean; created_at: string;
  acknowledged_at: string | null; csat_rating: number | null; csat_comment: string; messages: { id: string; author_role: string; body: string; at: string }[];
};

@Component({
  selector: "pc-shop-support-id-page",
  imports: [PcLink, PageLoader, Button, ErrorNote, Pill, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!t()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let tk = t()!;
      <div class="mx-auto flex max-w-3xl flex-col gap-3">
        <div class="rounded-xl bg-white p-5">
          <p class="text-sm text-ink-faint">{{ tk.number }}, {{ tk.category_label }}</p>
          <h1 class="text-2xl font-semibold">{{ tk.subject }}</h1>
          <div class="mt-2 flex flex-wrap gap-2">
            @if (tk.is_grievance) {<pc-pill tone="amber">Grievance</pc-pill>}
            <pc-pill [tone]="tk.status === 'awaiting_customer' ? 'amber' : tk.status === 'open' ? 'blue' : 'green'">{{ tk.status === "awaiting_customer" ? "Waiting for your reply" : tk.status === "open" ? "Waiting for us" : tk.status }}</pc-pill>
            @if (tk.order_id) {<a [pcLink]="'/orders/' + tk.order_id" class="text-sm font-semibold text-peacock">View order</a>}
          </div>
        </div>
        <ol class="flex flex-col gap-3">
          @for (m of tk.messages; track m.id) {
            <li [class]="m.author_role === 'customer' ? 'max-w-[85%] rounded-xl p-4 self-end bg-peacock-light' : 'max-w-[85%] rounded-xl p-4 self-start bg-white'">
              <p class="mb-1 text-xs font-semibold text-ink-faint">{{ m.author_role === "customer" ? "You" : site().brand_name + " support" }}, {{ dateTime(m.at) }}</p>
              <p class="whitespace-pre-line">{{ m.body }}</p>
            </li>
          }
        </ol>
        @if (tk.status === "resolved" || tk.status === "closed") {
          @if (tk.csat_rating) {
            <p class="rounded-xl bg-white p-4 text-sm" data-testid="csat-done">You rated this {{ tk.csat_rating }}/5. Thank you for telling us.</p>
          } @else {
            <form (submit)="rate($event)" class="flex flex-col gap-2 rounded-xl bg-white p-4" data-testid="csat-form">
              <p class="text-sm font-medium">How did we handle this request?</p>
              <div class="flex gap-1" role="radiogroup" aria-label="Rating">
                @for (n of [1, 2, 3, 4, 5]; track n) {
                  <button type="button" role="radio" [attr.aria-checked]="stars() === n" [attr.aria-label]="n + ' out of 5'" (click)="stars.set(n)" [class]="stars() >= n ? 'h-10 w-10 rounded-lg border text-lg font-semibold border-amber-400 bg-amber-100' : 'h-10 w-10 rounded-lg border text-lg font-semibold border-line'">{{ n }}</button>
                }
              </div>
              <textarea pcTextarea [value]="comment()" (input)="comment.set($any($event.target).value)" maxlength="500" placeholder="Anything you want to add (optional)" aria-label="Comment"></textarea>
              <div><button pcButton type="submit" [loading]="busy()" [disabled]="stars() === 0">Send rating</button></div>
            </form>
          }
        }
        @if (tk.status !== "closed") {
          <form (submit)="send($event)" class="flex flex-col gap-2 rounded-xl bg-white p-4">
            <pc-error-note [message]="error()" />
            <label for="reply" class="text-sm font-medium">Reply</label>
            <textarea pcTextarea id="reply" [value]="body()" (input)="body.set($any($event.target).value)" required maxlength="5000"></textarea>
            <div class="flex gap-2">
              <button pcButton type="submit" [loading]="busy()">Send</button>
              <button pcButton type="button" variant="ghost" (click)="close()">My issue is solved</button>
            </div>
          </form>
        }
      </div>
    }
  `,
})
export class ShopSupportIdPage {
  protected readonly site = inject(SiteService).site;
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get("id") ?? "")), { initialValue: "" });
  protected readonly t = signal<T | null>(null);
  protected readonly body = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly stars = signal(0);
  protected readonly comment = signal("");
  protected readonly dateTime = dateTime;

  constructor() {
    effect(() => {
      const id = this.id();
      if (id) untracked(() => this.load(id));
    });
  }

  private load(id: string): void {
    api<T>(`/api/support/tickets/${id}`).then((t) => this.t.set(t)).catch((e) => this.error.set(e.message));
  }

  protected async send(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    try {
      this.t.set(await api<T>(`/api/support/tickets/${this.id()}/messages`, { method: "POST", body: { body: this.body() } }));
      this.body.set("");
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not send");
    } finally {
      this.busy.set(false);
    }
  }

  protected async rate(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    try {
      this.t.set(await api<T>(`/api/support/tickets/${this.id()}/rating`, { method: "POST", body: { rating: this.stars(), comment: this.comment() } }));
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save your rating");
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    api<T>(`/api/support/tickets/${this.id()}/close`, { method: "POST" }).then((t) => this.t.set(t)).catch(quietly);
  }
}
