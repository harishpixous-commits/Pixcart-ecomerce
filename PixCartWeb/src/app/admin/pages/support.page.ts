/* Admin → Support desk: customer tickets by status, overdue and grievance filters. Port of frontend/src/app/admin/support/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, Input, Pagination, Pill } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";

type T = { id: string; number: string; subject: string; category_label: string; status: string; priority: string; is_grievance: boolean; customer: string; created_at: string; ack_due_at: string; ack_overdue: boolean; resolve_overdue: boolean; acknowledged_at: string | null };
type Csat = { rated: number; unrated_closed: number; average: number | null; spread: Record<string, number>; recent: { id: string; number: string; subject: string; rating: number; comment: string }[] };
type D = { items: T[]; status_counts: Record<string, number>; total: number; page: number; page_size: number };

const TICKET_STATUS: Record<string, string> = { open: "Open", awaiting_customer: "Waiting for customer", resolved: "Resolved", closed: "Closed" };

@Component({
  selector: "pc-admin-support-page",
  imports: [PageHeader, Table, Tabs, ExportButton, PcLink, PageLoader, EmptyState, Input, Pagination, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Support desk" sub="E-commerce rules: acknowledge every complaint within 48 hours and resolve it within one month." [withActions]="true">
        <pc-export-button actions scope="admin" name="tickets" [status]="status() === 'all' ? undefined : status()" />
      </pc-page-header>
      @if (csat(); as c) {
        <section class="mb-4 rounded-xl bg-white p-4 text-sm" data-testid="csat-summary">
          <h2 class="font-semibold">Customer satisfaction</h2>
          @if (c.rated === 0) {
            <p class="text-ink-soft">No ratings yet. {{ c.unrated_closed }} resolved requests are waiting for one.</p>
          } @else {
            <p class="mt-1">Average <span class="text-lg font-semibold">{{ c.average }}/5</span> from {{ c.rated }} ratings. {{ c.unrated_closed }} resolved requests are not rated yet.</p>
            <p class="mt-1 text-ink-soft">{{ spreadText(c) }}</p>
            <ul class="mt-2 flex flex-col gap-1">
              @for (r of commented(c); track r.id) {<li><a [pcLink]="'/admin/support/' + r.id" class="font-semibold text-peacock">{{ r.number }}</a> {{ r.rating }}/5, "{{ r.comment }}"</li>}
            </ul>
          }
        </section>
      }
      <div class="flex flex-wrap items-center gap-3">
        <pc-tabs [value]="status()" (valueChange)="go({ status: $event })" [items]="tabs()" />
        <label class="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="overdue()" (change)="setOverdue($any($event.target).checked)" /> Not acknowledged in time</label>
        <label class="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="grievance()" (change)="setGrievance($any($event.target).checked)" /> Grievances only</label>
      </div>
      <input pcInput placeholder="Ticket number, subject, customer name or mobile" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-sm" aria-label="Search tickets" />
      @if (!d()) {
        <pc-page-loader />
      } @else if (d()!.items.length === 0) {
        <pc-empty-state title="Nothing waiting" body="New tickets appear here." [hasAction]="false" />
      } @else {
        <pc-table [head]="['Ticket', 'Customer', 'Topic', 'Opened', 'Reply due', 'Status']">
          @for (t of d()!.items; track t.id) {
            <tr class="hover:bg-mist/60">
              <td class="px-4 py-2.5">
                <a [pcLink]="'/admin/support/' + t.id" class="font-semibold text-peacock">{{ t.number }}</a>
                <p class="line-clamp-1 text-sm">{{ t.subject }}</p>
              </td>
              <td class="px-4 py-2.5 text-sm">{{ t.customer }}</td>
              <td class="px-4 py-2.5 text-sm">{{ t.category_label }}{{ t.is_grievance ? " " : "" }}@if (t.is_grievance) {<pc-pill tone="red">Grievance</pc-pill>}</td>
              <td class="px-4 py-2.5 text-sm">{{ dateTime(t.created_at) }}</td>
              <td class="px-4 py-2.5 text-sm">@if (t.acknowledged_at) {Replied} @else {<span [class]="t.ack_overdue ? 'font-semibold text-vermilion' : ''">{{ dateTime(t.ack_due_at) }}</span>}</td>
              <td class="px-4 py-2.5">
                <pc-pill [tone]="t.status === 'open' ? 'blue' : t.status === 'resolved' || t.status === 'closed' ? 'green' : 'gray'">{{ label[t.status] }}</pc-pill>
                @if (t.priority !== "normal") {<p class="text-xs text-ink-faint">{{ t.priority }}</p>}
              </td>
            </tr>
          }
        </pc-table>
        <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
      }
    </div>
  `,
})
export class AdminSupportPage {
  private readonly router = inject(Router);
  protected readonly dateTime = dateTime;
  protected readonly label = TICKET_STATUS;
  private readonly statusParam = searchParam("status");
  private readonly overdueParam = searchParam("overdue");
  private readonly grievanceParam = searchParam("grievance");
  protected readonly status = computed(() => this.statusParam() ?? "open");
  protected readonly overdue = computed(() => this.overdueParam() === "1");
  protected readonly grievance = computed(() => this.grievanceParam() === "1");
  protected readonly d = signal<D | null>(null);
  protected readonly csat = signal<Csat | null>(null);
  protected spreadText(c: Csat): string { return [5, 4, 3, 2, 1].map((n) => `${n}: ${c.spread[String(n)] ?? 0}`).join("   "); }
  protected commented(c: Csat) { return c.recent.filter((r) => r.comment).slice(0, 3); }
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly tabs = computed(() => {
    const c = this.d()?.status_counts ?? {};
    return [...Object.entries(TICKET_STATUS).map(([v, l]) => ({ value: v, label: l, count: c[v] ?? 0 })), { value: "all", label: "All" }];
  });

  constructor() {
    api<Csat>("/api/admin/tickets/satisfaction").then((x) => this.csat.set(x)).catch(quietly);
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const status = this.status(), overdue = this.overdue(), grievance = this.grievance(), q = this.q(), page = this.page();
      clearTimeout(t);
      t = setTimeout(() => api<D>("/api/admin/tickets", { query: { status: status === "all" ? "" : status, overdue: overdue || undefined, grievance: grievance || undefined, q, page } })
        .then((x) => this.d.set(x)).catch(quietly), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected go(q: Record<string, string>): void {
    const p = new URLSearchParams({ status: this.status(), ...(this.overdue() ? { overdue: "1" } : {}), ...(this.grievance() ? { grievance: "1" } : {}), ...q });
    void this.router.navigateByUrl(`/admin/support?${p}`, { replaceUrl: true });
  }

  protected setOverdue(on: boolean): void {
    void this.router.navigateByUrl(`/admin/support?status=${this.status()}${on ? "&overdue=1" : ""}${this.grievance() ? "&grievance=1" : ""}`, { replaceUrl: true });
  }

  protected setGrievance(on: boolean): void {
    void this.router.navigateByUrl(`/admin/support?status=${this.status()}${this.overdue() ? "&overdue=1" : ""}${on ? "&grievance=1" : ""}`, { replaceUrl: true });
  }
}
