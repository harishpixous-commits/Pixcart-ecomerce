/*
 * Slide to pay, as in food-delivery and quick-commerce apps: drag the knob to the end of the track to confirm, so a
 * stray tap while scrolling can never place an order. Let go before 85% of the way and the knob springs back.
 *
 * Keyboard and screen-reader users get an ordinary button (role="button", focusable, named by aria-label): Enter or
 * Space confirms, and so does the click a screen reader sends when it activates the control. A click that comes from
 * a mouse, finger or pen is ignored; only the slide counts for those. Port of components/checkout/slide-to-pay.tsx:
 *   <pc-slide-to-pay ariaLabel="Slide to pay ₹1,234" loadingLabel="..." [disabled] [loading] (confirm)="..." extraClass="...">label</pc-slide-to-pay>
 */

import { ChangeDetectionStrategy, Component, ElementRef, booleanAttribute, computed, input, output, signal, viewChild } from "@angular/core";
import { ChevronsRight, Loader2 } from "lucide-angular";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";

const THRESHOLD = 0.85;
const INSET = 4; // px between the track and the knob (left-1 / top-1)

type Drag = { id: number; startX: number; x: number; max: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

@Component({
  selector: "pc-slide-to-pay",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div #track role="button" tabindex="0" [attr.aria-label]="loading() ? loadingLabel() : ariaLabel()" [attr.aria-disabled]="blocked() || null"
      [attr.aria-busy]="loading() || null" (keydown)="onKeyDown($event)" (click)="onClick($event)" (pointerdown)="pressed = true"
      data-testid="slide-to-pay" [class]="trackCls()">
      <span aria-hidden="true" [class]="trailCls()" [style.width.px]="x() + INSET * 2 + 48"></span>
      <span aria-hidden="true" class="pointer-events-none absolute inset-0 flex items-center justify-center pl-16 pr-5 text-[15px] font-semibold tracking-wide"
        [style.opacity]="loading() ? 1 : max0(1 - progress() * 1.6)">
        @if (loading()) {
          <span class="truncate">{{ loadingLabel() }}</span>
        } @else {
          <span [class]="labelCls()"><ng-content /></span>
        }
      </span>
      <span #knob aria-hidden="true" (pointerdown)="onPointerDown($event)" (pointermove)="onPointerMove($event)" (pointerup)="onPointerUp($event)"
        (pointercancel)="onPointerCancel($event)" [class]="knobCls()" [style.transform]="'translateX(' + x() + 'px)'">
        @if (loading()) {<svg [pcIcon]="Loader2" class="h-5 w-5 animate-spin" />} @else {<svg [pcIcon]="ChevronsRight" class="h-6 w-6" [strokeWidth]="2.5" />}
      </span>
    </div>
  `,
})
export class SlideToPay {
  readonly ariaLabel = input.required<string>();
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  readonly loadingLabel = input("Processing…");
  readonly tone = input<"buy" | "primary">("buy");
  readonly extraClass = input("");
  readonly confirm = output<void>();

  private readonly track = viewChild.required<ElementRef<HTMLDivElement>>("track");
  private readonly knob = viewChild.required<ElementRef<HTMLSpanElement>>("knob");
  protected pressed = false; // a mouse, finger or pen went down on the control since its last click
  protected readonly drag = signal<Drag | null>(null);
  // Where the knob rests (at the end of the track) while the order is being placed.
  private readonly endX = signal(0);
  protected readonly INSET = INSET;
  protected readonly Loader2 = Loader2;
  protected readonly ChevronsRight = ChevronsRight;
  protected readonly max0 = (n: number) => Math.max(0, n);

  protected readonly blocked = computed(() => this.disabled() || this.loading());
  protected readonly x = computed(() => {
    const d = this.drag();
    return d ? d.x : this.loading() ? this.endX() : 0;
  });
  private readonly max = computed(() => {
    const d = this.drag();
    return d ? d.max : this.endX();
  });
  protected readonly progress = computed(() => (this.loading() ? 1 : this.max() > 0 ? Math.min(1, this.x() / this.max()) : 0));

  private readonly buy = computed(() => this.tone() === "buy");
  protected readonly trackCls = computed(() =>
    cx(
      "relative h-14 w-full select-none overflow-hidden rounded-full text-white outline-none [-webkit-tap-highlight-color:transparent]",
      "shadow-[inset_0_-2px_0_rgba(0,0,0,0.12)] focus-visible:ring-2 focus-visible:ring-offset-2",
      this.buy() ? "bg-vermilion focus-visible:ring-vermilion" : "bg-peacock focus-visible:ring-peacock",
      this.disabled() && !this.loading() && "cursor-not-allowed opacity-55",
      this.extraClass(),
    ),
  );
  protected readonly trailCls = computed(() =>
    cx(
      "absolute inset-y-0 left-0 rounded-full",
      this.buy() ? "bg-vermilion-dark" : "bg-peacock-dark",
      !this.drag() && "motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
    ),
  );
  protected readonly labelCls = computed(() =>
    cx(
      "truncate",
      !this.blocked() &&
        "bg-[linear-gradient(100deg,rgba(255,255,255,0.72)_40%,#fff_50%,rgba(255,255,255,0.72)_60%)] bg-[length:250%_100%] bg-clip-text text-transparent motion-safe:animate-[skeleton-shimmer_2.6s_linear_infinite] motion-reduce:bg-none motion-reduce:text-white",
    ),
  );
  protected readonly knobCls = computed(() =>
    cx(
      "absolute left-1 top-1 flex h-12 w-12 touch-pan-y items-center justify-center rounded-full bg-white shadow-md",
      this.buy() ? "text-vermilion" : "text-peacock",
      this.blocked() ? "cursor-not-allowed" : this.drag() ? "cursor-grabbing" : "cursor-grab",
      !this.drag() && "motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
    ),
  );

  /** How far the knob can travel, measured when a slide starts (the bar can change width with the screen). */
  private travel(): number {
    const track = this.track().nativeElement;
    const knob = this.knob().nativeElement;
    return Math.max(0, track.clientWidth - knob.offsetWidth - INSET * 2);
  }

  private doConfirm(at: number): void {
    this.endX.set(at);
    this.confirm.emit();
  }

  protected onPointerDown(e: PointerEvent): void {
    if (this.blocked() || this.drag() || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault(); // no text selection or image drag while sliding
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag.set({ id: e.pointerId, startX: e.clientX, x: 0, max: this.travel() });
  }

  protected onPointerMove(e: PointerEvent): void {
    const d = this.drag();
    if (!d || e.pointerId !== d.id) return;
    this.drag.set({ ...d, x: clamp(e.clientX - d.startX, 0, d.max) });
  }

  protected onPointerUp(e: PointerEvent): void {
    const d = this.drag();
    if (!d || e.pointerId !== d.id) return;
    const at = clamp(e.clientX - d.startX, 0, d.max);
    this.drag.set(null); // springs back unless the parent starts loading
    if (d.max > 0 && at >= d.max * THRESHOLD) {
      navigator.vibrate?.(20);
      this.doConfirm(d.max);
    }
  }

  protected onPointerCancel(e: PointerEvent): void {
    const d = this.drag();
    if (d && e.pointerId === d.id) this.drag.set(null);
  }

  protected onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault(); // Space would scroll the page
    if (this.blocked() || e.repeat) return;
    this.doConfirm(this.travel());
  }

  protected onClick(e: MouseEvent): void {
    // A click from a pointing device follows its pointerdown (and, where clicks are pointer events, names its type).
    // A screen reader's "activate" has neither, so only that kind of click confirms.
    const pointerType = (e as MouseEvent & { pointerType?: string }).pointerType ?? "";
    const fromPointer = this.pressed || pointerType !== "";
    this.pressed = false;
    if (fromPointer || this.blocked()) return;
    this.doConfirm(this.travel());
  }
}
