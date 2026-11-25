/*
 * The pieces of the cart page: quantity stepper, heading, the signed-out cart, seller groups with free-delivery progress,
 * the bottom bars and "Saved for later". Port of the local components in frontend/src/app/(shop)/cart/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, booleanAttribute, computed, effect, inject, input, output, signal } from "@angular/core";
import { BadgePercent, Bookmark, Minus, Plus, Store, Trash2, Truck } from "lucide-angular";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import type { CartGroup, CartLine } from "../../core/types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ButtonLink, EmptyState, Pill, Price, ProductImage } from "../../shared/ui/ui";

export const SURFACE = "rounded-2xl bg-white shadow-sm ring-1 ring-black/5";
export const CART_CARD = `${SURFACE} p-4 sm:p-5`;
const LINE_ACTION = "inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const DELETE_CLS = cx(LINE_ACTION, "text-ink-soft hover:bg-vermilion-light hover:text-vermilion");
const SAVE_CLS = cx(LINE_ACTION, "text-peacock hover:bg-peacock-light");

const plural = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

@Component({
  selector: "pc-qty",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="inline-flex h-9 items-center rounded-lg border border-line bg-white">
      <button type="button" class="flex h-full w-9 items-center justify-center rounded-l-lg text-ink-soft hover:bg-mist disabled:opacity-40 disabled:hover:bg-transparent"
        (click)="valueChange.emit(value() - 1)" [disabled]="disabled() || value() <= 1" aria-label="Decrease quantity">
        <svg [pcIcon]="Minus" class="h-4 w-4" />
      </button>
      <span class="w-8 text-center font-semibold tabular-nums" aria-live="polite">{{ value() }}</span>
      <button type="button" class="flex h-full w-9 items-center justify-center rounded-r-lg text-ink-soft hover:bg-mist disabled:opacity-40 disabled:hover:bg-transparent"
        (click)="valueChange.emit(value() + 1)" [disabled]="disabled() || value() >= max()" aria-label="Increase quantity">
        <svg [pcIcon]="Plus" class="h-4 w-4" />
      </button>
    </div>
  `,
})
export class Qty {
  readonly value = input.required<number>();
  readonly max = input.required<number>();
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly valueChange = output<number>();
  protected readonly Minus = Minus;
  protected readonly Plus = Plus;
}

@Component({
  selector: "pc-cart-head",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
      <h1 class="text-2xl font-semibold">Shopping cart</h1>
      <p class="text-ink-soft">Subtotal ({{ plural(count()) }}): <span class="font-display font-bold text-ink">{{ fmt(subtotal()) }}</span></p>
    </div>
  `,
})
export class CartHead {
  readonly count = input.required<number>();
  readonly subtotal = input.required<number>();
  protected readonly fmt = rupees;
  protected readonly plural = plural;
}

/* ---------------------------------------------------------------- signed out (cart kept in this browser) */

/** Signed-out carts have no server bill: delivery and fees are worked out at checkout, so none is shown as free. */
@Component({
  selector: "pc-guest-summary",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="flex flex-col gap-3" aria-label="Price details">
      <h2 class="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Price details</h2>
      <dl class="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2.5 text-[15px]">
        <dt>Item total<span class="text-ink-faint"> ({{ plural(count()) }})</span></dt>
        <dd class="whitespace-nowrap text-right tabular-nums">@if (mrp() > total()) {<span class="mr-1.5 text-sm text-ink-faint line-through">{{ fmt(mrp()) }}</span>}{{ fmt(total()) }}</dd>
        <dt>Delivery</dt>
        <dd class="text-right text-sm text-ink-faint">At checkout</dd>
        <dt class="mt-1 border-t border-dashed border-line pt-3 font-display text-lg font-bold">Subtotal</dt>
        <dd class="mt-1 border-t border-dashed border-line pt-3 text-right font-display text-lg font-bold tabular-nums">{{ fmt(total()) }}</dd>
      </dl>
      @if (mrp() > total()) {
        <p class="flex items-center gap-2 rounded-xl bg-leaf-light px-3 py-2 text-sm font-semibold text-leaf">
          <svg [pcIcon]="BadgePercent" class="h-4 w-4 shrink-0" /> You save {{ fmt(mrp() - total()) }} on this order
        </p>
      }
    </section>
  `,
})
export class GuestSummary {
  readonly mrp = input.required<number>();
  readonly total = input.required<number>();
  readonly count = input.required<number>();
  protected readonly fmt = rupees;
  protected readonly plural = plural;
  protected readonly BadgePercent = BadgePercent;
}

@Component({
  selector: "pc-guest-cart",
  imports: [Icon, PcLink, ButtonLink, EmptyState, Price, ProductImage, Qty, CartHead, GuestSummary],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!lines().length) {
      <pc-empty-state title="Your cart is empty" body="Find something you like and add it here."><a pcButtonLink href="/" action>Start shopping</a></pc-empty-state>
    } @else {
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div class="flex min-w-0 flex-col gap-3">
          <pc-cart-head [count]="count()" [subtotal]="total()" />
          <section [class]="SURFACE + ' divide-y divide-line overflow-hidden'">
            @for (l of lines(); track l.variant_id) {
              <div class="p-4 sm:p-5">
                <div class="flex gap-3 sm:gap-4">
                  <a [pcLink]="'/p/' + l.slug" class="shrink-0" tabindex="-1" aria-hidden="true">
                    <pc-product-image [src]="l.image" [alt]="l.title" imgClass="h-20 w-20 rounded-xl sm:h-24 sm:w-24" />
                  </a>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <a [pcLink]="'/p/' + l.slug" class="line-clamp-2 font-medium leading-snug hover:text-peacock">{{ l.title }}</a>
                    @if (l.variant_label) {<p class="text-sm text-ink-faint">{{ l.variant_label }}</p>}
                    <p class="text-sm text-ink-faint">Seller: {{ l.seller_name }}</p>
                    <pc-price [price]="l.price" [mrp]="l.mrp" />
                  </div>
                </div>
                <div class="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 sm:mt-2 sm:pl-28">
                  <pc-qty [value]="l.qty" [max]="l.max ?? 10" (valueChange)="session.setGuestQty(l.variant_id, $event)" />
                  <button type="button" [class]="DELETE_CLS" (click)="session.setGuestQty(l.variant_id, 0)"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Remove</button>
                </div>
              </div>
            }
          </section>
        </div>
        <aside [class]="CART_CARD + ' flex flex-col gap-4 lg:sticky lg:top-36'">
          <pc-guest-summary [mrp]="mrp()" [total]="total()" [count]="count()" />
          <p class="text-sm text-ink-faint">Delivery charges are worked out at checkout.</p>
          <a pcButtonLink href="/login?next=/checkout" variant="buy" class="h-12">Sign in to place order</a>
        </aside>
      </div>
    }
  `,
})
export class GuestCart {
  protected readonly session = inject(SessionService);
  protected readonly lines = this.session.guestLines;
  protected readonly mrp = computed(() => this.lines().reduce((n, l) => n + l.mrp * l.qty, 0));
  protected readonly total = computed(() => this.lines().reduce((n, l) => n + l.price * l.qty, 0));
  protected readonly count = computed(() => this.lines().reduce((n, l) => n + l.qty, 0));
  protected readonly SURFACE = SURFACE;
  protected readonly CART_CARD = CART_CARD;
  protected readonly DELETE_CLS = DELETE_CLS;
  protected readonly Trash2 = Trash2;
}

/* ---------------------------------------------------------------- signed in */

@Component({
  selector: "pc-free-delivery-progress",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-1.5" data-testid="free-delivery-progress">
      <p class="flex items-start gap-2 text-sm text-ink-soft">
        <svg [pcIcon]="Truck" class="mt-0.5 h-4 w-4 shrink-0 text-marigold-dark" />
        <span>Add items worth <span class="font-semibold text-ink">{{ fmt(group().free_shipping_gap) }}</span> more for free delivery from {{ group().seller.name }}</span>
      </p>
      <div class="h-1.5 overflow-hidden rounded-full bg-mist" role="progressbar" [attr.aria-label]="'Progress towards free delivery from ' + group().seller.name"
        aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pct()">
        <div class="h-full rounded-full bg-marigold transition-[width] duration-500" [style.width]="max4(pct()) + '%'"></div>
      </div>
    </div>
  `,
})
export class FreeDeliveryProgress {
  readonly group = input.required<CartGroup>();
  protected readonly pct = computed(() => {
    const g = this.group();
    const goal = g.items_total + g.free_shipping_gap;
    return goal > 0 ? Math.min(100, Math.round((g.items_total / goal) * 100)) : 0;
  });
  protected readonly max4 = (n: number) => Math.max(n, 4);
  protected readonly fmt = rupees;
  protected readonly Truck = Truck;
}

@Component({
  selector: "pc-cart-line-row",
  imports: [Icon, PcLink, Price, ProductImage, Qty],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // the host is the row itself: the list's divide-y draws the line between rows
  host: { "[class]": "l().problem ? 'block p-4 sm:p-5 bg-vermilion-light/40' : 'block p-4 sm:p-5'", "data-testid": "cart-line" },
  template: `
      <div class="flex gap-3 sm:gap-4">
        <a [pcLink]="'/p/' + l().product_slug" class="shrink-0" tabindex="-1" aria-hidden="true">
          <pc-product-image [src]="l().image" [alt]="l().title" imgClass="h-20 w-20 rounded-xl bg-white sm:h-24 sm:w-24" />
        </a>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <a [pcLink]="'/p/' + l().product_slug" class="line-clamp-2 font-medium leading-snug hover:text-peacock">{{ l().title }}</a>
          @if (l().variant_label) {<p class="text-sm text-ink-faint">{{ l().variant_label }}</p>}
          <pc-price [price]="l().price" [mrp]="l().mrp" />
          @if (l().problem) {<p class="text-sm font-semibold text-vermilion">{{ l().problem }}</p>}
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 sm:mt-2 sm:pl-28">
        <pc-qty [value]="l().qty" [max]="max()" (valueChange)="qty.emit($event)" [disabled]="busy()" />
        <button type="button" [class]="DELETE_CLS" [disabled]="busy()" (click)="qty.emit(0)"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Delete</button>
        <button type="button" [class]="SAVE_CLS" [disabled]="busy()" (click)="save.emit()"><svg [pcIcon]="Bookmark" class="h-4 w-4" /> Save for later</button>
      </div>
  `,
})
export class CartLineRow {
  readonly l = input.required<CartLine>({ alias: "line" });
  readonly busy = input(false);
  readonly qty = output<number>();
  readonly save = output<void>();
  protected readonly max = computed(() => Math.max(1, this.l().max_qty ?? Math.min(10, this.l().stock_left)));
  protected readonly DELETE_CLS = DELETE_CLS;
  protected readonly SAVE_CLS = SAVE_CLS;
  protected readonly Trash2 = Trash2;
  protected readonly Bookmark = Bookmark;
}

@Component({
  selector: "pc-seller-group",
  imports: [Icon, PcLink, Pill, FreeDeliveryProgress, CartLineRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section [class]="SURFACE + ' overflow-hidden'">
      <header class="flex flex-col gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p class="flex min-w-0 items-center gap-2 font-semibold">
            <svg [pcIcon]="Store" class="h-4 w-4 shrink-0 text-peacock" />
            <span class="min-w-0 truncate">Sold by <a [pcLink]="'/store/' + g().seller.slug" class="text-peacock hover:underline">{{ g().seller.name }}</a></span>
          </p>
          @if (free()) {
            <pc-pill tone="green"><svg [pcIcon]="Truck" class="mr-1 h-3.5 w-3.5" />Free delivery</pc-pill>
          } @else if (g().shipping_fee > 0) {
            <span class="text-sm text-ink-soft">Delivery <span class="font-semibold text-ink">{{ fmt(g().shipping_fee) }}</span></span>
          }
        </div>
        @if (g().shipping_fee > 0 && g().free_shipping_gap > 0) {<pc-free-delivery-progress [group]="g()" />}
      </header>
      <div class="divide-y divide-line">
        @for (l of g().lines; track l.id) {
          <pc-cart-line-row [line]="l" [busy]="busy() === l.variant_id" (qty)="qty.emit({ variantId: l.variant_id, qty: $event })" (save)="save.emit(l.variant_id)" />
        }
      </div>
    </section>
  `,
})
export class SellerGroup {
  readonly g = input.required<CartGroup>({ alias: "group" });
  readonly busy = input<string | null>(null);
  readonly qty = output<{ variantId: string; qty: number }>();
  readonly save = output<string>();
  protected readonly free = computed(() => this.g().shipping_fee === 0 && this.g().items_total > 0);
  protected readonly fmt = rupees;
  protected readonly SURFACE = SURFACE;
  protected readonly Store = Store;
  protected readonly Truck = Truck;
}

function scrollToBill() {
  document.getElementById("cart-bill")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Phones and tablets: the total and the buy button stay in reach while the bill is scrolled out of sight. */
@Component({
  selector: "pc-checkout-bar",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="cls()" [attr.aria-hidden]="!show()" data-testid="cart-bar">
      <div class="mx-auto flex max-w-shop items-center gap-3">
        <div class="min-w-0 flex-1 leading-tight">
          <p class="font-display text-lg font-bold tabular-nums">{{ fmt(total()) }}</p>
          <button type="button" [attr.tabindex]="show() ? 0 : -1" class="text-xs font-semibold text-peacock hover:underline" (click)="scrollToBill()">View bill</button>
        </div>
        <button pcButton variant="buy" [disabled]="disabled()" (click)="buy.emit()" [attr.tabindex]="show() ? 0 : -1">Proceed to buy</button>
      </div>
    </div>
  `,
})
export class CheckoutBar {
  readonly watch = input<HTMLElement | undefined>(undefined);
  readonly total = input.required<number>();
  readonly disabled = input(false);
  readonly buy = output<void>();
  protected readonly show = signal(false);
  protected readonly fmt = rupees;
  protected readonly scrollToBill = scrollToBill;
  protected readonly cls = computed(() =>
    cx(
      "fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform sm:bottom-0 lg:hidden",
      this.show() ? "translate-y-0" : "pointer-events-none translate-y-[150%]",
    ),
  );

  constructor() {
    effect((onCleanup) => {
      const el = this.watch();
      if (!el) return;
      const io = new IntersectionObserver(([e]) => this.show.set(!e.isIntersecting), { threshold: 0 });
      io.observe(el);
      onCleanup(() => io.disconnect());
    });
    // Same flag as the product page's buy bar: the help button moves up and the compare tray steps aside.
    effect(() => {
      if (this.show()) document.body.dataset["buyBar"] = "1";
      else delete document.body.dataset["buyBar"];
    });
    inject(DestroyRef).onDestroy(() => delete document.body.dataset["buyBar"]);
  }
}

/**
 * The "bar at the bottom" cart layout: the total, the item count and Proceed to buy stay in reach on every screen size
 * (above the phone tab bar).
 */
@Component({
  selector: "pc-sticky-cart-bar",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-3 py-2.5 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur sm:bottom-0" data-testid="cart-bar">
      <div class="mx-auto flex max-w-3xl items-center gap-3">
        <div class="min-w-0 flex-1 leading-tight">
          <p class="font-display text-lg font-bold tabular-nums">{{ fmt(total()) }} <span class="font-sans text-sm font-normal text-ink-soft">· {{ plural(count()) }}</span></p>
          <button type="button" class="text-xs font-semibold text-peacock hover:underline" (click)="scrollToBill()">View bill</button>
        </div>
        <button pcButton variant="buy" size="lg" [disabled]="disabled()" (click)="buy.emit()" class="px-6">Proceed to buy</button>
      </div>
    </div>
  `,
})
export class StickyCartBar {
  readonly total = input.required<number>();
  readonly count = input.required<number>();
  readonly disabled = input(false);
  readonly buy = output<void>();
  protected readonly fmt = rupees;
  protected readonly plural = plural;
  protected readonly scrollToBill = scrollToBill;

  constructor() {
    // the help button moves up and the compare tray steps aside, as for the product page's buy bar
    document.body.dataset["buyBar"] = "1";
    inject(DestroyRef).onDestroy(() => delete document.body.dataset["buyBar"]);
  }
}

export type Saved = { variant_id: string; product_id: string; slug: string; title: string; variant_label: string; image: string; price: number; mrp: number; in_stock: boolean; available: boolean };

@Component({
  selector: "pc-saved-for-later",
  imports: [PcLink, Button, Price, ProductImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items().length) {
      <section [class]="SURFACE + ' overflow-hidden'" aria-labelledby="saved-h" data-testid="saved-for-later">
        <h2 id="saved-h" class="border-b border-line px-4 py-3 text-lg font-semibold sm:px-5">Saved for later <span class="font-sans text-base font-normal text-ink-faint">({{ plural(items().length) }})</span></h2>
        <div class="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
          @for (it of items(); track it.variant_id) {
            <div class="flex gap-3 rounded-xl border border-line p-3">
              <a [pcLink]="'/p/' + it.slug" class="shrink-0" tabindex="-1" aria-hidden="true">
                <pc-product-image [src]="it.image" [alt]="it.title" imgClass="h-20 w-20 rounded-lg" />
              </a>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <a [pcLink]="'/p/' + it.slug" class="line-clamp-2 text-sm font-medium leading-snug hover:text-peacock">{{ it.title }}</a>
                @if (it.variant_label) {<p class="text-xs text-ink-faint">{{ it.variant_label }}</p>}
                <pc-price [price]="it.price" [mrp]="it.mrp" size="sm" />
                @if (!it.in_stock) {<p class="text-xs font-semibold text-vermilion">{{ it.available ? "Out of stock" : "No longer available" }}</p>}
                <div class="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  <button pcButton size="sm" variant="secondary" [disabled]="!it.in_stock || busy() === it.variant_id" (click)="move.emit(it.variant_id)">Move to cart</button>
                  <button type="button" class="text-sm font-semibold text-ink-soft hover:text-vermilion" (click)="remove.emit(it.variant_id)">Delete</button>
                </div>
              </div>
            </div>
          }
        </div>
      </section>
    }
  `,
})
export class SavedForLater {
  readonly items = input.required<Saved[]>();
  readonly busy = input<string | null>(null);
  readonly move = output<string>();
  readonly remove = output<string>();
  protected readonly plural = plural;
  protected readonly SURFACE = SURFACE;
}
