/* The wishlist heart on product tiles and pages (when wishlists are on). Port of WishlistHeart in lib/wishlist.tsx.
 * The default look is the reference's; pass heartClass to replace it (the reference's className). */

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { Heart } from "lucide-angular";
import { SiteService } from "../../core/site";
import { WishlistService } from "../../core/wishlist";
import { Icon } from "../ui/icon";

@Component({
  selector: "pc-wishlist-heart",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().features.wishlist) {
      <button type="button" (click)="click($event)" [attr.aria-pressed]="on()" [attr.aria-label]="on() ? 'Remove from wishlist' : 'Save to wishlist'"
        [class]="heartClass() || 'absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 shadow-sm ring-1 ring-line hover:bg-white'">
        <svg [pcIcon]="Heart" [class]="on() ? 'h-5 w-5 fill-vermilion text-vermilion' : 'h-5 w-5 text-ink-faint'" />
      </button>
    }
  `,
})
export class WishlistHeart {
  readonly productId = input.required<string>();
  readonly heartClass = input<string>("");
  protected readonly site = inject(SiteService).site;
  private readonly wishlist = inject(WishlistService);
  protected readonly Heart = Heart;
  protected readonly on = computed(() => this.wishlist.ids().has(this.productId()));
  protected click(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    void this.wishlist.toggle(this.productId());
  }
}
