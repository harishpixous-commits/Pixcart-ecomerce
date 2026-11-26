/* Admin → Listings: the review queue for new and edited listings, by status. Port of frontend/src/app/admin/products/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api, quietly } from "../../core/api";
import { dateTime, rupees } from "../../core/format";
import type { Paged } from "../../core/types";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, Input, Pagination, ProductImage, StatusPill } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";

type Row = { id: string; title: string; slug: string; status: string; seller_name: string; image: string; price_from: number; mrp_from: number; submitted_at: string | null };
type Data = Paged<Row> & { status_counts?: Record<string, number> };

const TABS = [["pending", "To review"], ["approved", "Live"], ["rejected", "Rejected"], ["draft", "Drafts"], ["archived", "Archived"], ["", "All"]];

@Component({
  selector: "pc-admin-products-page",
  imports: [PageHeader, Table, Tabs, ExportButton, PcLink, PageLoader, EmptyState, Input, Pagination, ProductImage, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Listings" sub="Approve new listings and edited content before customers see them." [withActions]="true">
        <pc-export-button actions scope="admin" name="products" [status]="status() || undefined" [dated]="false" />
      </pc-page-header>
      <pc-tabs [value]="status()" (valueChange)="tab($event)" [items]="tabs()" />
      <input pcInput placeholder="Search titles" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-sm" aria-label="Search listings" />
      @if (!d()) {
        <pc-page-loader />
      } @else if (d()!.items.length === 0) {
        <pc-empty-state title="Nothing to review" [hasAction]="false" />
      } @else {
        <pc-table [head]="['Listing', 'Seller', 'Price', 'Submitted', 'Status']">
          @for (p of d()!.items; track p.id) {
            <tr class="hover:bg-mist/60">
              <td class="px-4 py-3">
                <a [pcLink]="'/admin/products/' + p.id" class="flex items-center gap-3">
                  <pc-product-image [src]="p.image" alt="" imgClass="h-12 w-12 shrink-0" />
                  <span class="line-clamp-2 font-medium text-peacock hover:underline">{{ p.title }}</span>
                </a>
              </td>
              <td class="px-4 py-3">{{ p.seller_name }}</td>
              <td class="px-4 py-3">{{ rupees(p.price_from) }}</td>
              <td class="px-4 py-3 text-sm">{{ dateTime(p.submitted_at) }}</td>
              <td class="px-4 py-3"><pc-status-pill [status]="p.status" /></td>
            </tr>
          }
        </pc-table>
        <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
      }
    </div>
  `,
})
export class AdminProductsPage {
  private readonly router = inject(Router);
  protected readonly rupees = rupees;
  protected readonly dateTime = dateTime;
  private readonly statusParam = searchParam("status");
  private readonly sellerParam = searchParam("seller_id");
  protected readonly status = computed(() => this.statusParam() ?? "pending");
  private readonly sellerId = computed(() => this.sellerParam() ?? undefined);
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly tabs = computed(() => {
    const c = this.d()?.status_counts ?? {};
    return TABS.map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }));
  });

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const status = this.status(), q = this.q(), page = this.page(), seller_id = this.sellerId();
      clearTimeout(t);
      t = setTimeout(() => api<Data>("/api/admin/products", { query: { status: status || undefined, q, page, seller_id } }).then((x) => this.d.set(x)).catch(quietly), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected tab(v: string): void {
    this.page.set(1);
    const sellerId = this.sellerId();
    void this.router.navigateByUrl(`/admin/products?status=${v}${sellerId ? `&seller_id=${sellerId}` : ""}`);
  }
}
