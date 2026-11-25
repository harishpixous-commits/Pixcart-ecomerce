/* Your orders: every order with its items, total and overall status, ten to a page. Port of frontend/src/app/(shop)/orders/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { api } from "../../core/api";
import { SUB_STATUS_LABEL, date, rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import type { OrderSummary, Paged } from "../../core/types";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink, EmptyState, Pagination, ProductImage, StatusPill } from "../../shared/ui/ui";

function overall(o: OrderSummary): { status: string; label: string } {
  if (o.status === "pending_payment") return { status: "pending_payment", label: "Awaiting payment" };
  if (o.status === "cancelled") return { status: "cancelled", label: "Cancelled" };
  const live = o.sub_statuses.filter((s) => s !== "cancelled");
  if (live.every((s) => s === "delivered")) return { status: "delivered", label: "Delivered" };
  if (live.some((s) => s === "shipped")) return { status: "shipped", label: "On the way" };
  return { status: live[0] ?? "placed", label: SUB_STATUS_LABEL[live[0] ?? "placed"] };
}

@Component({
  selector: "pc-shop-orders-page",
  imports: [PcLink, PageLoader, ButtonLink, EmptyState, Pagination, ProductImage, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!data()) {
      <pc-page-loader />
    } @else if (!data()!.items.length) {
      <pc-empty-state title="No orders yet" body="When you place an order it will appear here."><a pcButtonLink href="/" action>Start shopping</a></pc-empty-state>
    } @else {
      <div class="flex flex-col gap-3">
        <h1 class="px-1 text-2xl font-semibold">Your orders</h1>
        @for (o of data()!.items; track o.id) {
          @let st = overall(o);
          <a [pcLink]="'/orders/' + o.id" class="flex flex-col gap-3 rounded-xl bg-white p-4 hover:ring-2 hover:ring-peacock/20 sm:flex-row sm:items-center">
            <div class="flex -space-x-3">
              @for (it of o.items.slice(0, 3); track $index) {
                <pc-product-image [src]="it.image" [alt]="it.title" imgClass="h-16 w-16 rounded-lg border-2 border-white bg-white" />
              }
            </div>
            <div class="flex-1">
              <p class="line-clamp-1 font-medium">{{ o.items[0]?.title }}{{ o.item_count > 1 ? " and " + (o.item_count - 1) + " more" : "" }}</p>
              <p class="text-sm text-ink-faint">Order {{ o.number }}, placed {{ date(o.created_at) }}</p>
            </div>
            <div class="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
              <span class="font-display text-lg font-bold">{{ rupees(o.grand_total) }}</span>
              <pc-status-pill [status]="st.status" [label]="st.label" />
            </div>
          </a>
        }
        <pc-pagination [page]="data()!.page" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="page.set($event)" />
      </div>
    }
  `,
})
export class ShopOrdersPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  protected readonly page = signal(1);
  protected readonly data = signal<Paged<OrderSummary> | null>(null);
  protected readonly overall = overall;
  protected readonly date = date;
  protected readonly rupees = rupees;

  constructor() {
    effect(() => {
      if (this.session.ready() && !this.session.user()) void this.router.navigateByUrl("/login?next=/orders", { replaceUrl: true });
    });
    effect(() => {
      const user = this.session.user();
      const page = this.page();
      if (user)
        untracked(() =>
          api<Paged<OrderSummary>>("/api/orders", { query: { page } })
            .then((d) => this.data.set(d))
            .catch(() => this.data.set({ items: [], total: 0, page: 1, page_size: 10 })),
        );
    });
  }
}
