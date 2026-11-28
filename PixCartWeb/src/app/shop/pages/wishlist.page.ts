import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api } from "../../core/api";
import { SessionService } from "../../core/session";
import type { ProductCard } from "../../core/types";
import { WishlistService } from "../../core/wishlist";
import { ProductGrid } from "../../shared/product/product";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ButtonLink, EmptyState, Toast } from "../../shared/ui/ui";

/** "Share my wishlist": a private link, when Admin → Growth → Share wishlist is on. */
@Component({
  selector: "pc-wishlist-share",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (st(); as s) {
      @if (s.enabled) {
        <div class="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm" data-testid="wishlist-share">
          @if (s.token) {
            <p class="text-ink-soft">Anyone with this link can see your saved products and your first name.</p>
            <input readonly [value]="link()" aria-label="Share link" class="w-full rounded-lg border border-line px-2 py-1.5" (focus)="$any($event.target).select()" />
            <div class="flex gap-2">
              <button pcButton variant="secondary" type="button" (click)="copy()">Copy link</button>
              <button pcButton variant="ghost" type="button" [loading]="busy()" (click)="change(false)">Stop sharing</button>
            </div>
          } @else {
            <button pcButton variant="secondary" type="button" class="self-start" [loading]="busy()" (click)="change(true)">Share my wishlist</button>
          }
        </div>
      }
    }
  `,
})
export class WishlistShare {
  private readonly toast = inject(Toast);
  protected readonly st = signal<{ enabled: boolean; token: string | null } | null>(null);
  protected readonly busy = signal(false);
  protected readonly link = computed(() => (this.st()?.token ? `${window.location.origin}/wishlist/shared/${this.st()!.token}` : ""));
  constructor() {
    api<{ enabled: boolean; token: string | null }>("/api/wishlist/share").then((x) => this.st.set(x)).catch(() => {});
  }
  protected async change(on: boolean): Promise<void> {
    this.busy.set(true);
    try {
      this.st.set(await api<{ enabled: boolean; token: string | null }>("/api/wishlist/share", { method: on ? "POST" : "DELETE" }));
    } catch {
      this.toast.show("Could not change sharing. Try again.", "error");
    } finally {
      this.busy.set(false);
    }
  }
  protected copy(): void {
    void navigator.clipboard?.writeText(this.link()).then(() => this.toast.show("Link copied"));
  }
}

@Component({
  selector: "pc-shop-wishlist-page",
  imports: [ProductGrid, PageLoader, ButtonLink, EmptyState, WishlistShare],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (items() === null) { <pc-page-loader /> }
    @else {
      <div class="flex flex-col gap-3">
        <h1 class="px-1 text-2xl font-semibold">Your wishlist <span class="text-base font-normal text-ink-faint">({{ shown().length }})</span></h1>
        <pc-wishlist-share />
        @if (shown().length === 0) {
          <pc-empty-state title="Nothing saved yet" body="Tap the heart on any product to save it here for later.">
            <a pcButtonLink href="/" action>Browse products</a>
          </pc-empty-state>
        } @else { <pc-product-grid [items]="shown()" [dense]="true" /> }
      </div>
    }
  `,
})
export class ShopWishlistPage {
  private readonly session = inject(SessionService);
  private readonly wishlist = inject(WishlistService);
  private readonly router = inject(Router);
  readonly items = signal<ProductCard[] | null>(null);
  readonly shown = computed(() => (this.items() ?? []).filter(product => this.wishlist.ids().has(product.id)));
  constructor() {
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && !user) void this.router.navigateByUrl('/login?next=/wishlist', { replaceUrl: true });
      if (user) api<{ items: ProductCard[] }>('/api/wishlist').then(response => this.items.set(response.items)).catch(() => {});
    });
  }
}
