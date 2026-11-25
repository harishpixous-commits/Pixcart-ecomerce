/* Admin → one support ticket: the conversation, replies and internal notes, status and priority. Port of frontend/src/app/admin/support/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { AiBadge, AiDraftButton, type AiRun } from "../../shared/portal/ai";
import { PageHeader } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Pill, Select, Textarea, Toast } from "../../shared/ui/ui";

const STATUS: Record<string, string> = { open: "Open", awaiting_customer: "Waiting for customer", resolved: "Resolved", closed: "Closed" };

type T = {
  id: string; number: string; subject: string; category_label: string; status: string; priority: string; is_grievance: boolean; order_id: string | null; order_number: string | null;
  created_at: string; ack_due_at: string; resolve_due_at: string; ack_overdue: boolean; resolve_overdue: boolean; acknowledged_at: string | null;
  customer: { name: string; phone: string; email: string }; messages: { id: string; author_role: string; body: string; internal: boolean; at: string }[];
};

const CANNED = [
  "Thank you for writing to us. We are looking into this and will update you within 24 hours.",
  "We have asked the seller to check this and will get back to you shortly.",
  "Your refund has been processed. It reaches your account in 5 to 7 working days, depending on your bank.",
  "We are sorry for the trouble. Could you share a photo of the item and the packaging so we can raise this with the seller?",
];

@Component({
  selector: "pc-admin-support-id-page",
  imports: [PageHeader, PcLink, PageLoader, AiBadge, AiDraftButton, Button, ErrorNote, Field, Pill, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!t()) {
      <pc-page-loader />
    } @else {
      @let tk = t()!;
      <div class="flex flex-col gap-4">
        <pc-page-header [title]="tk.number + ': ' + tk.subject" [sub]="tk.category_label + ', opened ' + dateTime(tk.created_at)" [withActions]="true">
          <a actions pcLink="/admin/support" class="text-peacock">Back to desk</a>
        </pc-page-header>
        <div class="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div class="flex flex-col gap-3">
            @for (m of tk.messages; track m.id) {
              <div [class]="'max-w-[85%] rounded-xl p-3 ' + (m.internal ? 'self-center border border-dashed border-marigold bg-marigold-light' : m.author_role === 'staff' ? 'self-end bg-peacock-light' : 'self-start bg-white')">
                <p class="mb-1 text-xs text-ink-faint">{{ m.internal ? "Internal note" : m.author_role === "staff" ? "Support" : tk.customer.name || "Customer" }}, {{ dateTime(m.at) }}</p>
                <p class="whitespace-pre-line">{{ m.body }}</p>
              </div>
            }
            <section class="rounded-xl bg-white p-4">
              <pc-error-note [message]="error()" />
              <div class="mb-2"><pc-ai-draft-button base="/api/admin/ai" task="support_reply" [subjectId]="tk.id" [withIntent]="true" (draft)="useDraft($event)" /></div>
              @if (aiRun(); as r) {<p class="mb-1 flex items-center gap-2 text-xs text-ink-faint"><pc-ai-badge [mode]="r.mode" /> Edit the draft as needed; it is sent only when you press Send reply.</p>}
              <div class="mb-2 flex flex-wrap gap-1">
                @for (c of canned; track c) {<button type="button" (click)="body.set(c)" class="rounded-full bg-mist px-3 py-1 text-left text-xs hover:bg-peacock-light">{{ c.slice(0, 48) }}…</button>}
              </div>
              <textarea pcTextarea rows="4" [value]="body()" (input)="body.set($any($event.target).value)" [placeholder]="internal() ? 'Note for the team; the customer does not see it' : 'Reply to the customer'" aria-label="Message"></textarea>
              <div class="mt-2 flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="internal()" (change)="internal.set($any($event.target).checked)" /> Internal note</label>
                @if (!internal()) {
                  <select pcSelect [value]="status()" (change)="status.set($any($event.target).value)" class="w-auto" aria-label="Status after reply">
                    <option value="awaiting_customer">Then wait for customer</option><option value="open">Keep open</option><option value="resolved">Mark resolved</option>
                  </select>
                }
                <button pcButton (click)="send()" [loading]="busy()" [disabled]="!body().trim()" class="ml-auto">{{ internal() ? "Add note" : "Send reply" }}</button>
              </div>
            </section>
          </div>
          <aside class="flex flex-col gap-3 self-start">
            <section class="rounded-xl bg-white p-4 text-sm">
              <h2 class="mb-2 font-semibold">Customer</h2>
              <p>{{ tk.customer.name || "No name" }}</p>
              <p>{{ tk.customer.phone }}</p>
              <p>{{ tk.customer.email }}</p>
              @if (tk.order_id) {<a class="mt-2 inline-block font-semibold text-peacock" [pcLink]="'/admin/orders?q=' + tk.order_number">Order {{ tk.order_number }}</a>}
            </section>
            <section class="flex flex-col gap-2 rounded-xl bg-white p-4 text-sm">
              <h2 class="font-semibold">Ticket</h2>
              @if (tk.is_grievance) {<pc-pill tone="red">Grievance</pc-pill>}
              <pc-field label="Status" for="ts">
                <select pcSelect id="ts" (change)="setField({ status: $any($event.target).value })">
                  @for (s of statuses; track s[0]) {<option [value]="s[0]" [selected]="s[0] === tk.status">{{ s[1] }}</option>}
                </select>
              </pc-field>
              <pc-field label="Priority" for="tp">
                <select pcSelect id="tp" (change)="setField({ priority: $any($event.target).value })">
                  @for (p of priorities; track p) {<option [value]="p" [selected]="p === tk.priority">{{ p[0].toUpperCase() + p.slice(1) }}</option>}
                </select>
              </pc-field>
              <p>Reply by: <span [class]="tk.ack_overdue ? 'font-semibold text-vermilion' : ''">{{ tk.acknowledged_at ? "done" : dateTime(tk.ack_due_at) }}</span></p>
              <p>Resolve by: <span [class]="tk.resolve_overdue ? 'font-semibold text-vermilion' : ''">{{ dateTime(tk.resolve_due_at) }}</span></p>
            </section>
          </aside>
        </div>
      </div>
    }
  `,
})
export class AdminSupportIdPage {
  readonly id = input.required<string>();
  private readonly toast = inject(Toast);
  protected readonly dateTime = dateTime;
  protected readonly canned = CANNED;
  protected readonly statuses = Object.entries(STATUS);
  protected readonly priorities = ["low", "normal", "high", "urgent"];
  protected readonly t = signal<T | null>(null);
  protected readonly body = signal("");
  protected readonly internal = signal(false);
  protected readonly status = signal("awaiting_customer");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly aiRun = signal<AiRun | null>(null);

  constructor() {
    effect(() => {
      const id = this.id();
      api<T>(`/api/admin/tickets/${id}`).then((t) => this.t.set(t)).catch(quietly);
    });
  }

  protected useDraft(r: AiRun): void {
    this.aiRun.set(r);
    this.body.set(r.output.text ?? "");
    this.internal.set(false);
  }

  protected async send(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    const internal = this.internal(), aiRun = this.aiRun();
    try {
      this.t.set(await api<T>(`/api/admin/tickets/${this.id()}/reply`, {
        method: "POST", body: { body: this.body(), internal, status: internal ? undefined : this.status(), ai_run_id: aiRun && !internal ? aiRun.id : undefined },
      }));
      this.body.set("");
      this.aiRun.set(null);
      this.toast.show(internal ? "Note added" : "Reply sent to the customer");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      this.busy.set(false);
    }
  }

  protected async setField(patch: { status?: string; priority?: string }): Promise<void> {
    this.t.set(await api<T>(`/api/admin/tickets/${this.id()}/reply`, {
      method: "POST", body: { body: `Changed ${Object.entries(patch).map(([k, v]) => `${k} to ${v}`).join(", ")}`, internal: true, ...patch },
    }));
  }
}
