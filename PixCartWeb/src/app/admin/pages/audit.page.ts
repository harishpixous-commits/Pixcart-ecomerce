/* Admin → Audit log. Port of frontend/src/app/admin/audit/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, signal } from "@angular/core";
import { api, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader, Table } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button } from "../../shared/ui/ui";

type Row = { action: string; entity_type: string; entity_id: string; detail: string; actor: string; at: string };

@Component({
  selector: "pc-admin-audit-page",
  imports: [PageHeader, Table, PageLoader, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!rows()) {
      <pc-page-loader />
    } @else {
      <div>
        <pc-page-header title="Audit log" sub="Every approval, rejection, cancellation, settings change and KYC view." />
        <pc-table [head]="['When', 'Who', 'Action', 'Record', 'Detail']">
          @for (r of rows(); track $index) {
            <tr>
              <td class="whitespace-nowrap px-4 py-2 text-sm">{{ dateTime(r.at) }}</td>
              <td class="px-4 py-2">{{ r.actor }}</td>
              <td class="px-4 py-2 font-medium">{{ r.action }}</td>
              <td class="px-4 py-2 text-sm text-ink-faint">{{ r.entity_type }} {{ r.entity_id.slice(0, 8) }}</td>
              <td class="px-4 py-2 text-sm">{{ r.detail }}</td>
            </tr>
          }
        </pc-table>
        <div class="flex justify-center gap-2 py-4">
          <button pcButton variant="secondary" size="sm" [disabled]="page() === 1" (click)="page.set(page() - 1)">Newer</button>
          <button pcButton variant="secondary" size="sm" [disabled]="rows()!.length < 50" (click)="page.set(page() + 1)">Older</button>
        </div>
      </div>
    }
  `,
})
export class AdminAuditPage {
  protected readonly dateTime = dateTime;
  protected readonly page = signal(1);
  protected readonly rows = signal<Row[] | null>(null);
  constructor() {
    effect(() => {
      const page = this.page();
      api<{ items: Row[] }>("/api/admin/audit", { query: { page } }).then((d) => this.rows.set(d.items)).catch(quietly);
    });
  }
}
