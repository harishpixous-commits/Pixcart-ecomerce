/* "Review items" at checkout: the cart grouped by seller (each seller ships its own package). Port of components/checkout/review.tsx. */

import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { CircleAlert, ShoppingBag, Store, Truck } from "lucide-angular";
import { rupees } from "../../core/format";
import type { CartGroup } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { ProductImage } from "../../shared/ui/ui";
import { Bone, CARD, CardHeading } from "./card";

@Component({
  selector: "pc-items-review",
  imports: [Icon, PcLink, ProductImage, CardHeading],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-items-h" data-testid="checkout-items" [class]="CARD">
      <div pcCardHeading headingId="co-items-h" [icon]="ShoppingBag" title="Review items" [sub]="sub()" [hasAction]="true">
        <a action pcLink="/cart" class="rounded-lg px-2.5 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light">Edit cart</a>
      </div>
      @if (many()) {
        <p class="mb-3 flex items-start gap-2 rounded-xl bg-peacock-light/60 px-3 py-2 text-sm text-ink-soft">
          <svg [pcIcon]="Truck" class="mt-0.5 h-4 w-4 shrink-0 text-peacock" />Items from different sellers arrive in separate packages ({{ groups().length }} packages).
        </p>
      }
      <div class="flex flex-col gap-3">
        @for (g of groups(); track g.seller.id; let i = $index) {
          <div class="overflow-hidden rounded-xl ring-1 ring-line" data-testid="checkout-package">
            <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-mist/70 px-3 py-2">
              <p class="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
                <svg [pcIcon]="Store" class="h-4 w-4 shrink-0 text-peacock" />
                @if (many()) {<span class="shrink-0 text-ink-faint">Package {{ i + 1 }} ·</span>}
                <span class="truncate">{{ g.seller.name }}</span>
              </p>
              @if (g.shipping_fee) {
                <span class="text-xs font-medium text-ink-soft">Delivery {{ fmt(g.shipping_fee) }}</span>
              } @else {
                <span class="text-xs font-bold uppercase tracking-wide text-leaf">Free delivery</span>
              }
            </div>
            <ul class="divide-y divide-line">
              @for (l of g.lines; track l.id) {
                <li [class]="l.problem ? 'flex gap-3 p-3 bg-vermilion-light/40' : 'flex gap-3 p-3'" data-testid="checkout-line">
                  <pc-product-image [src]="l.image" alt="" [imgClass]="l.problem ? 'h-16 w-16 shrink-0 rounded-lg bg-white ring-1 ring-line opacity-60' : 'h-16 w-16 shrink-0 rounded-lg bg-white ring-1 ring-line'" />
                  <div class="min-w-0 flex-1">
                    <a [pcLink]="'/p/' + l.product_slug" class="line-clamp-2 text-[15px] leading-snug text-ink hover:text-peacock">{{ l.title }}</a>
                    <p class="mt-0.5 text-sm text-ink-faint">{{ meta(l.variant_label, l.qty) }}</p>
                    @if (l.problem) {
                      <p class="mt-1 flex items-start gap-1 text-sm font-semibold text-vermilion"><svg [pcIcon]="CircleAlert" class="mt-0.5 h-4 w-4 shrink-0" /> {{ l.problem }}</p>
                    }
                  </div>
                  <div class="shrink-0 text-right">
                    <p class="font-semibold tabular-nums text-ink">{{ fmt(l.line_total) }}</p>
                    @if (l.mrp > l.price) {<p class="text-xs tabular-nums text-ink-faint line-through">{{ fmt(l.mrp * l.qty) }}</p>}
                  </div>
                </li>
              }
            </ul>
          </div>
        }
      </div>
    </section>
  `,
})
export class ItemsReview {
  readonly groups = input.required<CartGroup[]>();
  readonly itemCount = input.required<number>();
  protected readonly many = computed(() => this.groups().length > 1);
  protected readonly sub = computed(() => `${this.itemCount()} item${this.itemCount() === 1 ? "" : "s"}${this.many() ? ` from ${this.groups().length} sellers` : ""}`);
  protected readonly fmt = rupees;
  protected readonly meta = (label: string, qty: number) => [label, `Qty ${qty}`].filter(Boolean).join(" · ");
  protected readonly CARD = CARD;
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly Truck = Truck;
  protected readonly Store = Store;
  protected readonly CircleAlert = CircleAlert;
}

@Component({
  selector: "pc-review-skeleton",
  imports: [Bone, CardHeading],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-items-h" data-testid="checkout-items-loading" [class]="CARD">
      <div pcCardHeading headingId="co-items-h" [icon]="ShoppingBag" title="Review items" sub="Getting your items…"></div>
      <div class="flex flex-col gap-3" aria-hidden="true">
        @for (i of [0, 1]; track i) {
          <div class="flex gap-3">
            <span pcBone class="h-16 w-16 shrink-0 rounded-lg"></span>
            <div class="flex flex-1 flex-col gap-2 pt-1">
              <span pcBone class="h-4 w-3/4"></span>
              <span pcBone class="h-3 w-1/3"></span>
            </div>
            <span pcBone class="h-4 w-14"></span>
          </div>
        }
      </div>
    </section>
  `,
})
export class ReviewSkeleton {
  protected readonly CARD = CARD;
  protected readonly ShoppingBag = ShoppingBag;
}

@Component({
  selector: "pc-bill-skeleton",
  imports: [Bone],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3", "aria-hidden": "true" },
  template: `
    <span pcBone class="h-3 w-24"></span>
    @for (i of [0, 1, 2]; track i) {
      <div class="flex justify-between gap-6"><span pcBone class="h-4 w-1/2"></span><span pcBone class="h-4 w-16"></span></div>
    }
    <div class="mt-1 flex justify-between gap-6 border-t border-dashed border-line pt-3"><span pcBone class="h-5 w-20"></span><span pcBone class="h-5 w-20"></span></div>
  `,
})
export class BillSkeleton {}
