/* The seller's listings: one tab per status plus low stock, search, export and bulk upload. Port of frontend/src/app/seller/products/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import type { Paged } from "../../core/types";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { ExportButton } from "../../shared/portal/export-button";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink, EmptyState, Input, Pagination, ProductImage, StatusPill } from "../../shared/ui/ui";

type Row = { id: string; title: string; slug: string; status: string; rejection_reason: string; image: string; price_from: number; mrp_from: number; total_stock: number; updated_at: string };
type Data = Paged<Row> & { low_stock_threshold?: number };

const STATUS_LABEL: Record<string, string> = { approved: "Live", pending: "In review", rejected: "Needs changes", draft: "Draft", archived: "Archived" };

@Component({
  selector: "pc-seller-products-page",
  imports: [PageHeader, Table, Tabs, ExportButton, PcLink, PageLoader, ButtonLink, EmptyState, Input, Pagination, ProductImage, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Products" [withActions]="true">
        <ng-container ngProjectAs="[actions]">
          <pc-export-button scope="seller" name="products" [status]="status() || undefined" [dated]="false" />
          <a pcButtonLink href="/seller/products/import" variant="secondary">Bulk upload</a>
          <a pcButtonLink href="/seller/products/new">Add a product</a>
        </ng-container>
      </pc-page-header>
      <pc-tabs [value]="lowStock() ? 'low' : status()" (valueChange)="tab($event)" [items]="tabs()" />
      <input pcInput placeholder="Search by title or SKU" [value]="q()" (input)="search($any($event.target).value)" class="mb-3 max-w-sm" aria-label="Search products" />
      @if (!data()) {
        <pc-page-loader />
      } @else if (data()!.items.length === 0) {
        <pc-empty-state [title]="total() ? 'Nothing here' : 'No products yet'" [body]="total() ? 'Try another tab or search.' : 'Add your first product to start selling.'" [hasAction]="!total()">
          <a pcButtonLink action href="/seller/products/new">Add a product</a>
        </pc-empty-state>
      } @else {
        <pc-table [head]="head">
          @for (p of data()!.items; track p.id) {
            <tr class="hover:bg-mist/60">
              <td class="px-4 py-3">
                <a [pcLink]="'/seller/products/' + p.id" class="flex items-center gap-3">
                  <pc-product-image [src]="p.image" alt="" imgClass="h-12 w-12 shrink-0 rounded" />
                  <span>
                    <span class="line-clamp-1 font-medium hover:text-peacock">{{ p.title }}</span>
                    @if (p.status === "rejected" && p.rejection_reason) {<span class="line-clamp-1 text-sm text-vermilion">{{ p.rejection_reason }}</span>}
                  </span>
                </a>
              </td>
              <td class="px-4 py-3">{{ p.price_from ? rupees(p.price_from) : "—" }}</td>
              <td [class]="p.total_stock <= (data()!.low_stock_threshold ?? 5) ? 'px-4 py-3 font-semibold text-vermilion' : 'px-4 py-3'">{{ p.total_stock }}</td>
              <td class="px-4 py-3"><pc-status-pill [status]="p.status" [label]="label[p.status]" /></td>
              <td class="px-4 py-3 text-sm text-ink-faint">{{ date(p.updated_at) }}</td>
            </tr>
          }
        </pc-table>
        <pc-pagination [page]="data()!.page" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="page.set($event)" />
      }
    </div>
  `,
})
export class SellerProductsPage {
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  protected readonly head = ["Product", "Price", "Stock", "Status", "Updated"];
  protected readonly label = STATUS_LABEL;
  protected readonly date = date;
  protected readonly rupees = rupees;
  protected readonly status = computed(() => this.route.params().get("status") ?? "");
  protected readonly lowStock = computed(() => this.route.params().get("low_stock") === "1");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly data = signal<Data | null>(null);
  protected readonly total = computed(() => Object.values(this.data()?.status_counts ?? {}).reduce((a, b) => a + b, 0));
  protected readonly tabs = computed(() => {
    const counts = this.data()?.status_counts ?? {};
    return [
      { value: "", label: "All", count: this.total() },
      ...["approved", "pending", "rejected", "draft", "archived"].map((s) => ({ value: s, label: STATUS_LABEL[s], count: counts[s] ?? 0 })),
      { value: "low", label: "Low stock" },
    ];
  });

  constructor() {
    effect((onCleanup) => {
      const status = this.status();
      const lowStock = this.lowStock();
      const q = this.q();
      const page = this.page();
      const t = setTimeout(() => {
        api<Data>("/api/seller/products", { query: { status: status || undefined, q, page, low_stock: lowStock || undefined } }).then((d) => this.data.set(d)).catch(quietly);
      }, q ? 250 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected tab(v: string): void {
    this.page.set(1);
    void this.router.navigateByUrl(v === "low" ? "/seller/products?low_stock=1" : v ? `/seller/products?status=${v}` : "/seller/products");
  }

  protected search(v: string): void {
    this.q.set(v);
    this.page.set(1);
  }
}
