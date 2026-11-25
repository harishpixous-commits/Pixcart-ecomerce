/* "Your browsing history": products seen in this browser (newest first). Port of RecentlyViewedRail in components/pdp.tsx. */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { rupees } from "../../core/format";
import { readViewed } from "../../core/wishlist";
import { PcLink } from "../../shared/ui/link";

@Component({
  selector: "pc-recently-viewed-rail",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items().length >= 1) {
      <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="recent-h">
        <h2 id="recent-h" class="mb-3 text-xl font-semibold">Your browsing history</h2>
        <div class="scroll-x flex gap-3 overflow-x-auto">
          @for (x of items(); track x.id) {
            <a [pcLink]="'/p/' + x.slug" class="w-32 shrink-0 hover:text-peacock">
              <img [src]="x.image" [alt]="x.title" class="mb-1 aspect-square w-full rounded-lg bg-mist object-contain" />
              <p class="line-clamp-2 text-sm">{{ x.title }}</p>
              <p class="font-display font-bold">{{ fmt(x.price) }}</p>
            </a>
          }
        </div>
      </section>
    }
  `,
})
export class RecentlyViewedRail {
  readonly currentId = input("");
  // read once from this browser's storage
  private readonly viewed = signal(readViewed());
  protected readonly items = computed(() => this.viewed().filter((x) => x.id !== this.currentId()));
  protected readonly fmt = rupees;
}
