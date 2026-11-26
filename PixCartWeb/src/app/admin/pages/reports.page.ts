/* Admin → Reports: the monthly GST TCS report for GSTR-8 and its CSV. Port of frontend/src/app/admin/reports/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, signal } from "@angular/core";
import { api, ApiError, downloadFile, quietly } from "../../core/api";
import { pct, rupeesExact } from "../../core/format";
import { PageHeader, Table } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Input } from "../../shared/ui/ui";

type Row = { seller_id: string; legal_name: string; gstin: string; net_taxable_value: number; igst_tcs: number; cgst_tcs: number; sgst_tcs: number; sub_orders: number; returned_value?: number };
type R = { month: string; tcs_rate_bps: number; note: string; items: Row[]; totals: Record<string, number> };

@Component({
  selector: "pc-admin-reports-page",
  imports: [PageHeader, Table, PcLink, PageLoader, Button, ErrorNote, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    <pc-page-header title="Reports" sub="GST TCS for GSTR-8 (due by the 10th of the next month) and data exports for your accountant." [withActions]="!!(r() && r()!.items.length > 0)">
      @if (r() && r()!.items.length > 0) {<button actions pcButton variant="secondary" (click)="download()">Download CSV</button>}
    </pc-page-header>
    <p class="rounded-xl bg-white p-4 text-sm">All other data (orders, GST line items, returns, payouts, catalogue, customers) is on the <a pcLink="/admin/exports" class="font-semibold text-peacock">Exports</a> page.</p>
    <pc-error-note [message]="dlError()" />
    <input pcInput type="month" [value]="month()" (input)="month.set($any($event.target).value)" class="w-48" aria-label="Month" />
    @if (!r()) {
      <pc-page-loader />
    } @else {
      <p class="text-sm text-ink-soft">Rate {{ pct(r()!.tcs_rate_bps) }}. {{ r()!.note }}</p>
      <pc-table [head]="['Seller', 'GSTIN', 'Packages', 'Returns', 'Net taxable value', 'IGST', 'CGST', 'SGST']">
        @for (i of r()!.items; track i.seller_id) {
          <tr>
            <td class="px-4 py-2.5">{{ i.legal_name }}</td>
            <td class="px-4 py-2.5 font-mono text-sm">{{ i.gstin }}</td>
            <td class="px-4 py-2.5">{{ i.sub_orders }}</td>
            <td class="px-4 py-2.5 text-vermilion">{{ i.returned_value ? "−" + rupeesExact(i.returned_value) : "—" }}</td>
            <td class="px-4 py-2.5">{{ rupeesExact(i.net_taxable_value) }}</td>
            <td class="px-4 py-2.5">{{ rupeesExact(i.igst_tcs) }}</td>
            <td class="px-4 py-2.5">{{ rupeesExact(i.cgst_tcs) }}</td>
            <td class="px-4 py-2.5">{{ rupeesExact(i.sgst_tcs) }}</td>
          </tr>
        }
        <tr class="font-semibold">
          <td class="px-4 py-2.5" colspan="4">Total</td>
          <td class="px-4 py-2.5">{{ rupeesExact(r()!.totals["net_taxable_value"] ?? 0) }}</td>
          <td class="px-4 py-2.5">{{ rupeesExact(r()!.totals["igst_tcs"] ?? 0) }}</td>
          <td class="px-4 py-2.5">{{ rupeesExact(r()!.totals["cgst_tcs"] ?? 0) }}</td>
          <td class="px-4 py-2.5">{{ rupeesExact(r()!.totals["sgst_tcs"] ?? 0) }}</td>
        </tr>
      </pc-table>
    }
  `,
})
export class AdminReportsPage {
  protected readonly pct = pct;
  protected readonly rupeesExact = rupeesExact;
  protected readonly month = signal(AdminReportsPage.thisMonth());
  private readonly rv = signal<{ month: string; data: R } | null>(null);
  protected readonly dlError = signal<string | null>(null);
  // a new month shows the loader, not last month's numbers
  protected readonly r = computed(() => {
    const rv = this.rv();
    return rv && rv.month === this.month() ? rv.data : null;
  });

  private static thisMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  constructor() {
    effect(() => {
      const month = this.month();
      api<R>("/api/admin/reports/tcs", { query: { month } }).then((data) => this.rv.set({ month, data })).catch(quietly);
    });
  }

  protected download(): void {
    this.dlError.set(null);
    const month = this.month();
    downloadFile("/api/admin/exports/tcs.csv", { month }, `tcs-${month}.csv`).catch((e) => this.dlError.set(e instanceof ApiError || e instanceof Error ? e.message : String(e)));
  }
}
