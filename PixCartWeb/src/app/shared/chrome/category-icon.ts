/* The icon of a top-level category (by slug). Port of components/category-icon.tsx: <svg [pcCategoryIcon]="slug" class="h-5 w-5" />. */

import { Directive, ElementRef, effect, inject, input } from "@angular/core";
import { Baby, BookOpen, Dumbbell, Laptop, Shirt, ShoppingBasket, Sofa, Sparkles, Tag, type LucideIconData } from "lucide-angular";
import { ICON_HOST, drawIcon } from "../ui/icon";

const ICONS: Record<string, LucideIconData> = {
  "mobiles-electronics": Laptop,
  fashion: Shirt,
  "home-kitchen": Sofa,
  "beauty-personal-care": Sparkles,
  grocery: ShoppingBasket,
  books: BookOpen,
  "toys-baby": Baby,
  "sports-fitness": Dumbbell,
};

export function categoryIcon(slug: string): LucideIconData {
  return ICONS[slug] ?? Tag;
}

@Directive({ selector: "svg[pcCategoryIcon]", host: { ...ICON_HOST, class: "lucide", "aria-hidden": "true" } })
export class CategoryIcon {
  readonly pcCategoryIcon = input.required<string>();
  constructor() {
    const el = inject<ElementRef<SVGSVGElement>>(ElementRef).nativeElement;
    effect(() => drawIcon(el, categoryIcon(this.pcCategoryIcon())));
  }
}
