/* "Buy the set": a bundle offer that includes this product, with its price after the discount and "Add the set to cart".
 * Port of components/bundle-set.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { ApiError, api } from "../../core/api";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import type { ProductCard } from "../../core/types";
import { PcLink } from "../../shared/ui/link";
import { Button, Toast } from "../../shared/ui/ui";

type Bundle = { code: string; automatic: boolean; percent: number; items: ProductCard[]; total: number; saving: number; set_price: number };

@Component({
  selector: "pc-bundle-set",
  imports: [PcLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (bundle(); as b) {
      <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="set-h" data-testid="bundle-set">
        <h2 id="set-h" class="mb-3 text-xl font-semibold">Buy the set, save {{ b.percent }}%</h2>
        <ul class="flex flex-col gap-1.5 text-sm">
          @for (p of b.items; track p.id) {
            <li>
              <a [pcLink]="'/p/' + p.slug" class="hover:text-peacock">{{ p.title }}</a>{{ " " }}<span class="font-semibold">{{ rupees(p.price) }}</span>
              @if (!p.variant_id) {<span class="text-ink-faint"> · choose options on its page</span>}
            </li>
          }
        </ul>
        <p class="mt-3 text-lg">
          Set price: <span class="font-display font-bold">{{ rupees(b.set_price) }}</span>{{ " " }}
          <span class="text-sm text-ink-faint line-through">{{ rupees(b.total) }}</span>{{ " " }}
          <span class="text-sm font-semibold text-peacock">You save {{ rupees(b.saving) }}</span>
        </p>
        <p class="mt-1 text-xs text-ink-faint">{{ b.automatic ? "The discount is applied at checkout." : "Use code " + b.code + " at checkout." }}</p>
        <button pcButton variant="cart" class="mt-3" (click)="addSet()" [loading]="busy()" [disabled]="!addable().length">Add the set to cart</button>
      </section>
    }
  `,
})
export class BundleSet {
  readonly slug = input.required<string>();
  private readonly session = inject(SessionService);
  private readonly toast = inject(Toast);
  protected readonly rupees = rupees;
  protected readonly bundle = signal<Bundle | null>(null);
  protected readonly busy = signal(false);
  protected readonly addable = computed(() => (this.bundle()?.items ?? []).filter((p) => p.variant_id && p.in_stock));

  constructor() {
    effect((onCleanup) => {
      const slug = this.slug();
      let live = true;
      api<{ bundles: Bundle[] }>(`/api/catalog/products/${slug}/bundles`).then((r) => { if (live) this.bundle.set(r.bundles[0] ?? null); }).catch(() => { if (live) this.bundle.set(null); });
      onCleanup(() => (live = false));
    });
  }

  protected async addSet() {
    const addable = this.addable(), needsChoice = (this.bundle()?.items ?? []).filter((p) => !p.variant_id);
    this.busy.set(true);
    try {
      for (const p of addable) {
        await this.session.addToCart({ variant_id: p.variant_id!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      }
      this.toast.show(`${addable.length} item${addable.length === 1 ? "" : "s"} added to your cart${needsChoice.length ? ". Choose options for the rest." : ""}`);
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
