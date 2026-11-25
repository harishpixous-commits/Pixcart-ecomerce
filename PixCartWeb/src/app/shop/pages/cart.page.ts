/*
 * Shopping cart: the signed-out cart kept in this browser, or the account's cart grouped by seller with the bill,
 * "Saved for later" and the browsing history. Port of frontend/src/app/(shop)/cart/page.tsx.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import { ApiError, api, latestOnly } from "../../core/api";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { CartView } from "../../core/types";
import { BillDetails } from "../../shared/commerce/bill";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ButtonLink, EmptyState, ErrorNote, Toast } from "../../shared/ui/ui";
import { ThemeService } from "../../themes/context";
import { CART_CARD, CartHead, CheckoutBar, GuestCart, SavedForLater, SellerGroup, StickyCartBar, type Saved } from "../customer/cart-parts";
import { RecentlyViewedRail } from "../customer/recent-rail";

@Component({
  selector: "pc-shop-cart-page",
  imports: [NgTemplateOutlet, PageLoader, Button, ButtonLink, EmptyState, ErrorNote, BillDetails, CartHead, CheckoutBar, GuestCart, SavedForLater, SellerGroup, StickyCartBar, RecentlyViewedRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #savedBlock>
      <pc-saved-for-later [items]="saved()" [busy]="busy()" (move)="move('/api/cart/saved/' + $event + '/move-to-cart', $event, 'Moved to your cart')" (remove)="removeSaved($event)" />
    </ng-template>
    @if (!session.ready()) {
      <pc-page-loader />
    } @else if (!session.user()) {
      <pc-guest-cart /><div class="mt-4"><pc-recently-viewed-rail currentId="" /></div>
    } @else if (error()) {
      <pc-error-note [message]="error()" />
    } @else if (!cart()) {
      <pc-page-loader />
    } @else if (!cart()!.groups.length) {
      <div class="flex flex-col gap-4">
        <pc-empty-state title="Your cart is empty" [body]="saved().length ? 'Your saved items are below.' : 'Find something you like and add it here.'"><a pcButtonLink href="/" action>Start shopping</a></pc-empty-state>
        <ng-container [ngTemplateOutlet]="savedBlock" />
        <pc-recently-viewed-rail currentId="" />
      </div>
    } @else {
      @let c = cart()!;
      @let s = c.summary;
      <div [class]="stickyBar() ? 'flex flex-col gap-4 mx-auto w-full max-w-3xl pb-24' : 'flex flex-col gap-4'" [attr.data-cart-layout]="stickyBar() ? 'sticky' : 'side'">
        <div [class]="stickyBar() ? 'grid gap-4' : 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start'">
          <div class="flex min-w-0 flex-col gap-3">
            <pc-cart-head [count]="s.item_count" [subtotal]="s.items_total" />
            @for (g of c.groups; track g.seller.id) {
              <pc-seller-group [group]="g" [busy]="busy()" (qty)="setQty($event.variantId, $event.qty)" (save)="move('/api/cart/items/' + $event + '/save-for-later', $event, 'Saved for later')" />
            }
          </div>
          <aside id="cart-bill" [class]="CART_CARD + (stickyBar() ? ' flex scroll-mt-56 flex-col gap-4 sm:scroll-mt-44' : ' flex scroll-mt-56 flex-col gap-4 sm:scroll-mt-44 lg:sticky lg:top-36')">
            <pc-bill-details
              [bill]="{ mrp_total: s.mrp_total, items_total: s.items_total, item_count: s.item_count, shipping_total: s.shipping_total, fees: s.fees, fee_savings: s.fee_savings, grand_total: s.grand_total }"
              [deliveryLabel]="c.checkout?.delivery_label" [deliveryInfo]="c.checkout?.delivery_info" [hints]="c.hints ?? []" totalLabel="Total" />
            @if (s.has_problems) {<p class="rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion">Remove or update the items marked in red to continue.</p>}
            <button #buy pcButton variant="buy" size="lg" [disabled]="cannotBuy()" (click)="checkout()">Proceed to buy</button>
            <p class="text-center text-xs text-ink-faint">Prices include GST. {{ site().features.coupons ? "Apply coupons and choose how to pay at checkout." : "Choose how to pay at checkout." }}</p>
          </aside>
        </div>
        <ng-container [ngTemplateOutlet]="savedBlock" />
        <pc-recently-viewed-rail currentId="" />
        @if (stickyBar()) {
          <pc-sticky-cart-bar [total]="s.grand_total" [count]="s.item_count" [disabled]="cannotBuy()" (buy)="checkout()" />
        } @else {
          <pc-checkout-bar [watch]="buyEl()" [total]="s.grand_total" [disabled]="cannotBuy()" (buy)="checkout()" />
        }
      </div>
    }
  `,
})
export class ShopCartPage {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  protected readonly site = inject(SiteService).site;
  private readonly theme = inject(ThemeService);
  protected readonly stickyBar = computed(() => this.theme.layout().cart.summary === "sticky");
  protected readonly cart = signal<CartView | null>(null);
  protected readonly saved = signal<Saved[]>([]);
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly buy = viewChild("buy", { read: ElementRef });
  protected readonly buyEl = computed(() => this.buy()?.nativeElement as HTMLElement | undefined);
  // Quantity changes on different lines can overlap; only the newest cart (and its bill) is shown.
  private readonly track = latestOnly();
  protected readonly CART_CARD = CART_CARD;
  protected readonly cannotBuy = computed(() => {
    const s = this.cart()?.summary;
    return !s || s.has_problems || s.item_count === 0;
  });

  constructor() {
    effect(() => {
      if (this.session.ready() && this.session.user()) untracked(() => this.load());
    });
  }

  private load(): void {
    this.track(Promise.all([api<CartView>("/api/cart"), api<{ items: Saved[] }>("/api/cart/saved")]), ([c, sv]) => {
      this.cart.set(c);
      this.saved.set(sv.items);
    }).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load your cart"));
  }

  protected async setQty(variantId: string, qty: number): Promise<void> {
    this.busy.set(variantId);
    try {
      await this.track(api<CartView>("/api/cart/items", { method: "PUT", body: { variant_id: variantId, qty } }), (c) => {
        this.cart.set(c);
        if (c.notice) this.toast.show(c.notice);
      });
      await this.session.refreshCart();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not update the cart", "error");
    } finally {
      this.busy.set(null);
    }
  }

  protected async move(path: string, variantId: string, done: string): Promise<void> {
    this.busy.set(variantId);
    try {
      await this.track(api<{ cart: CartView; saved: { items: Saved[] } }>(path, { method: "POST" }), (r) => {
        this.cart.set(r.cart);
        this.saved.set(r.saved.items);
      });
      await this.session.refreshCart();
      this.toast.show(done);
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not update the cart", "error");
    } finally {
      this.busy.set(null);
    }
  }

  protected async removeSaved(variantId: string): Promise<void> {
    try {
      this.saved.set((await api<{ items: Saved[] }>(`/api/cart/saved/${variantId}`, { method: "DELETE" })).items);
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }

  protected checkout(): void {
    void this.router.navigateByUrl("/checkout");
  }
}
