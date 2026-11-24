/*
 * Lucide icons drawn straight into an <svg>, with the same attributes lucide-react renders (24×24 viewBox, stroke
 * currentColor, stroke width 2, round caps and joins, class "lucide"), so icons size and align exactly like the
 * reference. Usage: <svg [pcIcon]="Search" class="h-5 w-5" /> with `Search` imported from "lucide-angular".
 */

import { Directive, ElementRef, effect, inject, input } from "@angular/core";
import type { LucideIconData } from "lucide-angular";

const NS = "http://www.w3.org/2000/svg";

@Directive({
  selector: "svg[pcIcon]",
  host: {
    xmlns: NS,
    width: "24",
    height: "24",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "lucide",
    "[attr.stroke-width]": "strokeWidth()",
    "[attr.aria-hidden]": "ariaHidden()",
  },
})
export class Icon {
  readonly pcIcon = input.required<LucideIconData>();
  readonly strokeWidth = input<number | string>(2);
  /** decorative by default, like most icons beside a text label */
  readonly ariaHidden = input<string | null>("true");
  private readonly el = inject<ElementRef<SVGSVGElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => drawIcon(this.el, this.pcIcon()));
  }
}

/** Replaces an <svg>'s children with a lucide icon's shapes. */
export function drawIcon(el: SVGElement, nodes: LucideIconData): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const [tag, attrs] of nodes) {
    const child = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (k !== "key") child.setAttribute(k, String(v));
    el.appendChild(child);
  }
}

/** The same svg attributes as Icon, for components that draw a fixed icon themselves. */
export const ICON_HOST = {
  xmlns: NS, width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
  "stroke-linecap": "round", "stroke-linejoin": "round",
} as const;
