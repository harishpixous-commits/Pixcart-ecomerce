/* Admin → AI agents: a master switch, one switch per agent, and the proposals waiting for a decision. Mirrors /api/admin/agents/*
 * in both the .NET and the Python versions. Agents write proposals from real data; nothing happens until a person presses Approve. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { date } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Toast } from "../../shared/ui/ui";

type AgentInfo = { key: string; label: string; job: string; not_wired: string; enabled: boolean; pending: number };
type Overview = { settings: Record<string, boolean | number>; agents: AgentInfo[] };
type Proposal = { id: string; agent: string; kind: string; summary: string; details: string[][]; status: string; result: { note?: string; error?: string }; created_at: string };

const NUMBERS: Record<string, string> = {
  delivery_nudge_hours: "Remind seller after (hours unshipped)",
  delivery_tracking_hours: "Ask for tracking after (hours since shipped)",
  delivery_cancel_hours: "Propose cancel and refund after (hours unshipped)",
  delivery_max_age_days: "Ignore packages older than (days)",
  reorder_cover_days: "Restock when stock lasts less than (days)",
  reorder_window_days: "Sales window (days)",
  marketing_window_days: "Sales window (days)",
  marketing_max_sold: "Slow if it sold at most (units)",
  marketing_min_items: "Only categories with at least (items in stock)",
  marketing_discount_percent: "Discount (%)",
  marketing_valid_days: "Coupon valid for (days)",
  support_wait_hours: "Reply when a ticket waited (hours)",
  support_max_age_days: "Ignore tickets older than (days)",
  reorder_min_sold: "Only items that sold at least (units)",
  orderupdate_late_hours: "Tell customer after (hours past the promised date)",
  orderupdate_max_age_days: "Ignore packages more than (days) past due",
};

@Component({
  selector: "pc-admin-agents-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="AI agents" sub="Agents look at your real orders and write proposals. Nothing happens until you press Approve. They run on plain rules, with no paid AI service.">
      <button actions pcButton (click)="runNow()">Run now</button>
    </pc-page-header>
    @if (error()) { <pc-error-note [message]="error()" /> }
    @if (ov(); as o) {
      <div data-testid="agents-page">
        <label class="mb-4 flex items-center gap-3 rounded-lg bg-white p-3"><input type="checkbox" [checked]="!!o.settings['enabled']" (change)="put('enabled', $any($event.target).checked)" /> <span class="font-semibold">Agents switched on (master switch)</span></label>
        <div class="grid gap-3 md:grid-cols-2">
          @for (a of o.agents; track a.key) {
            <section class="rounded-xl bg-white p-4" [attr.data-testid]="'agent-' + a.key">
              <label class="flex items-center gap-3"><input type="checkbox" [checked]="!!o.settings[a.key + '_enabled']" (change)="put(a.key + '_enabled', $any($event.target).checked)" /> <span class="font-semibold">{{ a.label }}</span> <span class="text-sm text-ink-soft">{{ a.pending }} waiting</span></label>
              <p class="mt-2 text-sm">{{ a.job }}</p>
              <p class="mt-1 text-sm text-ink-soft">Not done yet: {{ a.not_wired }}</p>
              <div class="mt-3 grid gap-2 sm:grid-cols-2">
                @for (k of numberKeys(a.key); track k) {
                  <label class="flex flex-col gap-1 text-sm"><span>{{ labels[k] }}</span>
                    <input class="rounded-lg border border-line px-3 py-2" [value]="o.settings[k]" (change)="put(k, +$any($event.target).value)" /></label>
                }
              </div>
            </section>
          }
        </div>
        <div class="mt-6 flex items-center gap-2">
          <h2 class="text-lg font-semibold">Proposals</h2>
          @for (s of statuses; track s) { <button type="button" class="rounded-full px-3 py-1 text-sm" [class]="status() === s ? 'bg-peacock text-white' : 'bg-white'" (click)="pick(s)">{{ s }}</button> }
        </div>
        <div class="mt-3 flex flex-col gap-3" data-testid="agent-proposals">
          @if (items().length === 0) { <p class="rounded-lg bg-white p-4 text-sm">Nothing here.</p> }
          @for (p of items(); track p.id) {
            <div class="rounded-xl bg-white p-4">
              <p class="font-semibold">{{ p.summary }}</p>
              <p class="text-sm text-ink-soft">{{ detail(p) }} · {{ date(p.created_at) }}</p>
              @if (p.result.note || p.result.error) { <p class="mt-1 text-sm">{{ p.result.note || p.result.error }}</p> }
              @if (p.status === "pending") {
                <div class="mt-3 flex gap-2"><button pcButton (click)="decide(p, 'approve')">Approve</button><button pcButton variant="secondary" (click)="decide(p, 'reject')">Reject</button></div>
              }
            </div>
          }
        </div>
      </div>
    } @else if (!error()) { <pc-page-loader /> }
  `,
})
export class AdminAgentsPage {
  private readonly toast = inject(Toast);
  protected readonly labels = NUMBERS;
  protected readonly date = date;
  protected readonly statuses = ["pending", "done", "rejected", "expired", "failed"];
  protected readonly ov = signal<Overview | null>(null);
  protected readonly items = signal<Proposal[]>([]);
  protected readonly status = signal("pending");
  protected readonly error = signal<string | null>(null);

  constructor() { this.load(); }

  protected numberKeys = (agent: string): string[] => Object.keys(NUMBERS).filter((k) => k.startsWith(agent + "_"));
  protected detail = (p: Proposal): string => p.details.map(([k, v]) => `${k}: ${v}`).join(" · ");
  protected pick(s: string): void { this.status.set(s); this.load(); }

  protected load(): void {
    api<Overview>("/api/admin/agents").then((x) => this.ov.set(x)).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load"));
    api<{ items: Proposal[] }>(`/api/admin/agents/proposals?status=${this.status()}`).then((x) => this.items.set(x.items)).catch(quietly);
  }

  protected put(key: string, value: boolean | number): Promise<void> { return this.save({ [key]: value }); }

  protected async save(patch: Record<string, boolean | number>): Promise<void> {
    try { await api("/api/admin/agents/settings", { method: "PUT", body: patch }); this.load(); } catch (e) { this.toast.show(e instanceof ApiError ? e.message : "Could not save", "error"); }
  }

  protected async decide(p: Proposal, d: "approve" | "reject"): Promise<void> {
    try { await api(`/api/admin/agents/proposals/${p.id}/${d}`, { method: "POST", body: {} }); this.toast.show(d === "approve" ? "Done" : "Rejected"); } catch (e) { this.toast.show(e instanceof ApiError ? e.message : "Could not do this", "error"); }
    this.load();
  }

  protected async runNow(): Promise<void> {
    const r = await api<{ new: Record<string, number> }>("/api/admin/agents/run", { method: "POST", body: {} });
    this.toast.show(`${Object.values(r.new).reduce((a, b) => a + b, 0)} new proposal(s)`);
    this.load();
  }
}
