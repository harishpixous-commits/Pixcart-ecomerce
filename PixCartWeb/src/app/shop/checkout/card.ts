/*
 * The card and heading every checkout section is built from, so the page reads as one surface.
 * Port of components/checkout/card.tsx:
 *   <section [class]="CARD"> ... </section>   (Card)
 *   <div pcCardHeading id="co-x-h" [icon]="MapPin" tone="marigold" title="..." sub="..."><button action>..</button></div>
 *   <span pcIconBadge [icon]="Leaf" tone="leaf"></span>   <span pcBone class="h-4 w-1/2"></span>
 */

import { ChangeDetectionStrategy, Component, Directive, booleanAttribute, computed, input } from "@angular/core";
import type { LucideIconData } from "lucide-angular";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";

export const CARD = "rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5";

export type Tone = "peacock" | "leaf" | "marigold";

export function badgeClass(tone: Tone = "peacock"): string {
  return cx(
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
    tone === "peacock" && "bg-peacock-light text-peacock",
    tone === "leaf" && "bg-leaf-light text-leaf",
    tone === "marigold" && "bg-marigold-light text-marigold-dark",
  );
}

@Component({
  selector: "span[pcIconBadge]",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()" },
  template: `<svg [pcIcon]="icon()" class="h-5 w-5" />`,
})
export class IconBadge {
  readonly icon = input.required<LucideIconData>();
  readonly tone = input<Tone>("peacock");
  protected readonly cls = computed(() => badgeClass(this.tone()));
}

@Component({
  selector: "div[pcCardHeading]",
  imports: [IconBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mb-4 flex items-start gap-3" },
  template: `
    <span pcIconBadge [icon]="icon()" [tone]="tone()"></span>
    <div class="min-w-0 flex-1 self-center">
      <h2 [id]="hid()" class="font-display text-lg font-semibold leading-tight text-ink">{{ title() }}</h2>
      @if (sub()) {<p class="mt-0.5 text-sm leading-snug text-ink-soft">{{ sub() }}</p>}
    </div>
    @if (hasAction()) {<div class="shrink-0 self-center"><ng-content select="[action]" /></div>}
  `,
})
export class CardHeading {
  readonly hid = input.required<string>({ alias: "headingId" });
  readonly icon = input.required<LucideIconData>();
  readonly tone = input<Tone>("peacock");
  readonly title = input.required<string>();
  readonly sub = input<string | null | undefined>(undefined);
  readonly hasAction = input(false, { transform: booleanAttribute });
}

/** A grey placeholder bar in the shape of the text that is loading. */
@Directive({ selector: "span[pcBone]", host: { class: "skeleton block rounded-md", "aria-hidden": "true" } })
export class Bone {}
