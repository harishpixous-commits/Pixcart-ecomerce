/* "Frequently bought together": products that real customers ordered with this one, with one-click "Add all to cart".
 * Port of components/bought-together.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { Plus } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { ProductCard } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, Toast } from "../../shared/ui/ui";

@Component({
  selector: "pc-bought-together",
  imports: [Icon, PcLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().features.bought_together !== false && items() && items()!.length >= 2) {
      <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="fbt-h" data-testid="bought-together">
        <h2 id="fbt-h" class="mb-3 text-xl font-semibold">Frequently bought together</h2>
        <div class="flex flex-col gap-5 lg:flex-row lg:items-center">
          <div class="flex flex-wrap items-center gap-2">
            @for (p of items(); track p.id; let i = $index) {
              <div class="flex items-center gap-2">
                @if (i > 0) {<svg [pcIcon]="Plus" class="h-5 w-5 text-ink-faint" />}
                <a [pcLink]="'/p/' + p.slug" [class]="off().has(p.id) ? 'block h-24 w-24 overflow-hidden rounded-lg bg-mist p-1 sm:h-28 sm:w-28 opacity-40' : 'block h-24 w-24 overflow-hidden rounded-lg bg-mist p-1 sm:h-28 sm:w-28'">
                  <img [src]="p.image" [alt]="p.title" class="h-full w-full object-contain mix-blend-multiply" />
                </a>
              </div>
            }
          </div>
          <div class="flex flex-col gap-2 lg:ml-6 lg:min-w-[220px]">
            <p class="text-lg">Total price: <span class="font-display font-bold">{{ rupees(total()) }}</span></p>
            <button pcButton variant="cart" (click)="addAll()" [loading]="busy()" [disabled]="!addable().length">
              {{ picked().length === items()!.length ? "Add all " + addable().length + " to cart" : "Add " + addable().length + " to cart" }}
            </button>
            @if (needsChoice().length > 0) {<p class="text-xs text-ink-faint">Some items have sizes or colours: choose them on their pages.</p>}
          </div>
        </div>
        <ul class="mt-4 flex flex-col gap-1.5 text-sm">
          @for (p of items(); track p.id; let i = $index) {
            <li>
              <label class="flex cursor-pointer items-start gap-2">
                <input type="checkbox" class="mt-1 accent-peacock" [checked]="!off().has(p.id)" (change)="toggle(p.id, $any($event.target).checked)" />
                <span>
                  @if (i === 0) {<span class="font-semibold">This item: </span>}
                  <a [pcLink]="'/p/' + p.slug" class="hover:text-peacock">{{ p.title }}</a>{{ " " }}<span class="font-semibold">{{ rupees(p.price) }}</span>
                  @if (!p.variant_id) {<span class="text-ink-faint"> · choose options on its page</span>}
                </span>
              </label>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class BoughtTogether {
  readonly slug = input.required<string>();
  protected readonly site = inject(SiteService).site;
  private readonly session = inject(SessionService);
  private readonly toast = inject(Toast);
  protected readonly Plus = Plus;
  protected readonly rupees = rupees;
  protected readonly items = signal<ProductCard[] | null>(null);
  protected readonly off = signal<Set<string>>(new Set());
  protected readonly busy = signal(false);
  protected readonly picked = computed(() => (this.items() ?? []).filter((p) => !this.off().has(p.id)));
  protected readonly total = computed(() => this.picked().reduce((n, p) => n + p.price, 0));
  protected readonly addable = computed(() => this.picked().filter((p) => p.variant_id && p.in_stock));
  protected readonly needsChoice = computed(() => this.picked().filter((p) => !p.variant_id));

  constructor() {
    effect((onCleanup) => {
      const slug = this.slug();
      let live = true;
      api<{ items: ProductCard[] }>(`/api/catalog/products/${slug}/bought-together`).then((r) => { if (live) this.items.set(r.items); }).catch(() => { if (live) this.items.set([]); });
      onCleanup(() => (live = false));
    });
  }

  protected toggle(id: string, on: boolean) {
    this.off.update((s) => {
      const n = new Set(s);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  protected async addAll() {
    const addable = this.addable(), needsChoice = this.needsChoice();
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
