/* Seller → Quality: your late shipments, cancellations and returns against the levels the marketplace set (Admin → Growth → Seller scorecard). */

import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { api, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";

type Me = { orders: number; late: number; cancelled_by_seller: number; returned: number; late_percent: number; cancel_percent: number; return_percent: number; level: string };
type Card = { enabled: boolean; window_days?: number; ship_within_hours?: number; min_orders?: number; limits?: Record<string, number>; you?: Me };

@Component({
  selector: "pc-seller-quality-page",
  imports: [PageHeader, PageLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Quality" sub="How your orders are doing. Keep these figures under the warning level to stay in good standing." />
    @if (!c()) { <pc-page-loader /> }
    @else if (!c()!.enabled) { <p class="rounded-xl bg-white p-5 text-ink-soft">The marketplace is not tracking seller quality yet.</p> }
    @else {
      @let d = c()!;
      <p class="mb-3 text-sm text-ink-soft">Last {{ d.window_days }} days. Orders count as late when not shipped within {{ d.ship_within_hours }} hours. {{ levelText(d.you!.level) }}@if (d.you!.level === "not_enough_orders") { (needs at least {{ d.min_orders }} orders) }.</p>
      <div class="grid gap-3 sm:grid-cols-3" data-testid="seller-quality">
        <section class="rounded-xl bg-white p-5"><div class="text-sm text-ink-soft">Late shipments</div><div class="text-2xl font-semibold">{{ d.you!.late_percent }}%</div><div class="text-sm text-ink-soft">{{ d.you!.late }} of {{ d.you!.orders }} orders. Warning at {{ d.limits!['late_warn_percent'] }}%, critical at {{ d.limits!['late_critical_percent'] }}%</div></section>
        <section class="rounded-xl bg-white p-5"><div class="text-sm text-ink-soft">Cancelled by you</div><div class="text-2xl font-semibold">{{ d.you!.cancel_percent }}%</div><div class="text-sm text-ink-soft">{{ d.you!.cancelled_by_seller }} of {{ d.you!.orders }} orders. Warning at {{ d.limits!['cancel_warn_percent'] }}%, critical at {{ d.limits!['cancel_critical_percent'] }}%</div></section>
        <section class="rounded-xl bg-white p-5"><div class="text-sm text-ink-soft">Returns</div><div class="text-2xl font-semibold">{{ d.you!.return_percent }}%</div><div class="text-sm text-ink-soft">{{ d.you!.returned }} of {{ d.you!.orders }} orders. Warning at {{ d.limits!['return_warn_percent'] }}%, critical at {{ d.limits!['return_critical_percent'] }}%</div></section>
      </div>
    }
  `,
})
export class SellerQualityPage {
  protected readonly c = signal<Card | null>(null);
  constructor() { api<Card>("/api/seller/scorecard").then((x) => this.c.set(x)).catch(quietly); }
  protected levelText = (l: string): string => ({ ok: "Your standing: good", warning: "Your standing: warning", critical: "Your standing: critical", not_enough_orders: "Not enough orders to rate yet" } as Record<string, string>)[l] ?? l;
}
