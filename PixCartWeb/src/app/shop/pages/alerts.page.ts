/* Your alerts: "back in stock" alerts with Remove, and the note on wishlist price drops. Port of frontend/src/app/(shop)/alerts/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from "@angular/core";
import { Bell, BellOff, Heart } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { date } from "../../core/format";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, ProductImage, Toast } from "../../shared/ui/ui";

type StockAlertRow = { variant_id: string; product: string; slug: string; variant: string; image: string; in_stock: boolean; created_at: string };

@Component({
  selector: "pc-shop-alerts-page",
  imports: [Icon, PcLink, PageLoader, EmptyState, ProductImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.ready()) {
      <pc-page-loader />
    } @else if (!session.user()) {
      <pc-empty-state title="Sign in to see your alerts" body="We tell you when items you follow are back in stock or cheaper.">
        <a action pcLink="/login?next=/alerts" class="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Sign in</a>
      </pc-empty-state>
    } @else {
      <div class="flex flex-col gap-4">
        <header class="rounded-xl bg-white p-4 sm:p-6">
          <h1 class="flex items-center gap-2 text-2xl font-semibold"><svg [pcIcon]="Bell" class="h-6 w-6 text-peacock" /> Your alerts</h1>
          <p class="text-ink-soft">We send a notification (and an email when you have one on your account) as soon as something changes.</p>
        </header>
        <section class="rounded-xl bg-white" aria-labelledby="stock-h">
          <h2 id="stock-h" class="border-b border-line px-4 py-3 text-lg font-semibold">Back in stock</h2>
          @if (items() === null) {
            <pc-page-loader />
          } @else if (items()!.length === 0) {
            <p class="px-4 py-6 text-ink-soft">No alerts. On a product that is out of stock, choose <span class="font-semibold">Notify me</span> and we will tell you when it is back.</p>
          } @else {
            <ul class="divide-y divide-line" data-testid="stock-alerts">
              @for (a of items(); track a.variant_id) {
                <li class="flex items-center gap-3 px-4 py-3">
                  <pc-product-image [src]="a.image" [alt]="a.product" imgClass="h-16 w-16 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <a [pcLink]="'/p/' + a.slug" class="line-clamp-2 font-medium hover:text-peacock">{{ a.product }}</a>
                    @if (a.variant) {<p class="text-sm text-ink-faint">{{ a.variant }}</p>}
                    <p [class]="a.in_stock ? 'text-sm font-semibold text-leaf' : 'text-sm text-ink-soft'">{{ a.in_stock ? "Back in stock now" : "Waiting for stock · since " + date(a.created_at) }}</p>
                  </div>
                  <button type="button" (click)="remove(a.variant_id)" class="flex items-center gap-1 text-sm text-ink-soft hover:text-vermilion"><svg [pcIcon]="BellOff" class="h-4 w-4" /> Remove</button>
                </li>
              }
            </ul>
          }
        </section>
        @if (site().features.price_alerts !== false) {
          <section class="flex items-start gap-3 rounded-xl bg-white p-4">
            <svg [pcIcon]="Heart" class="mt-0.5 h-5 w-5 shrink-0 text-vermilion" />
            <p class="text-sm text-ink-soft">
              <span class="font-semibold text-ink">Price drops:</span> products in your <a pcLink="/wishlist" class="font-semibold text-peacock">wishlist</a> are watched for you.
              When one gets cheaper than when you saved it, we let you know.
            </p>
          </section>
        }
      </div>
    }
  `,
})
export class ShopAlertsPage {
  protected readonly session = inject(SessionService);
  protected readonly site = inject(SiteService).site;
  private readonly toast = inject(Toast);
  protected readonly items = signal<StockAlertRow[] | null>(null);
  protected readonly date = date;
  protected readonly Bell = Bell;
  protected readonly BellOff = BellOff;
  protected readonly Heart = Heart;

  constructor() {
    effect(() => {
      if (this.session.ready() && this.session.user()) untracked(() => this.load());
    });
  }

  private load(): void {
    api<{ stock: StockAlertRow[] }>("/api/alerts").then((r) => this.items.set(r.stock)).catch(() => this.items.set([]));
  }

  protected async remove(id: string): Promise<void> {
    try {
      await api(`/api/alerts/stock/${id}`, { method: "DELETE" });
      this.items.update((x) => (x ?? []).filter((a) => a.variant_id !== id));
      this.toast.show("Alert removed");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not remove", "error");
    }
  }
}
