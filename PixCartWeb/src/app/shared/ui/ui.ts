/*
 * The shared UI kit. Port of frontend/src/components/ui.tsx with the same markup and classes, so screens look the same:
 *
 *   <button pcButton variant="primary|cart|buy|secondary|ghost|danger|outlineLight" size="sm|md|lg" [loading]="busy()">
 *   <a pcButtonLink href="/orders" variant="secondary">
 *   <pc-field label="Name" hint="..." [error]="err"><input pcInput /></pc-field>   (the label is linked to the control)
 *   <input pcInput [invalid]="x">  <textarea pcTextarea>  <select pcSelect>
 *   <pc-text-field label="Mobile number" type="tel" [(value)]="phone" hint="..." [error]="e" />
 *   <svg pcSpinner class="h-6 w-6" />   <pc-page-loader variant="list" />
 *   <pc-price [price]="p" [mrp]="m" size="lg" />  <pc-rating [value]="4.2" [count]="12" />
 *   <pc-pill tone="green">Paid</pc-pill>  <pc-status-pill status="delivered" />
 *   <pc-empty-state title="..." body="..."><a pcButtonLink ...>action</a></pc-empty-state>
 *   <pc-error-note [message]="error()" />   <pc-pagination [page] [pageSize] [total] (pageChange)="..." />
 *   <pc-modal [open]="o()" (close)="o.set(false)" title="..." [wide]="true">...</pc-modal>   (PrimeNG Dialog)
 *   inject(Toast).show("Saved") / .show("Could not save", "error")   (useToast)
 *   <pc-product-image [src] [alt] class="h-20 w-20" />
 */

import {
  ChangeDetectionStrategy, Component, Directive, ElementRef, Injectable, InjectionToken, OnInit, afterNextRender, booleanAttribute, computed,
  inject, input, model, numberAttribute, output, signal,
} from "@angular/core";
import { Loader2, Star, X } from "lucide-angular";
import { Dialog } from "primeng/dialog";
import { rupees } from "../../core/format";
import { cx } from "./cx";
import { ICON_HOST, Icon, drawIcon } from "./icon";
import { PcLink } from "./link";

/* ---------------------------------------------------------------- buttons */

export type ButtonVariant = "primary" | "cart" | "buy" | "secondary" | "ghost" | "danger" | "outlineLight";

export const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-peacock text-white hover:bg-peacock-dark",
  cart: "bg-marigold text-ink hover:bg-marigold-dark",
  buy: "bg-vermilion text-white hover:bg-vermilion-dark",
  secondary: "bg-white text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light",
  ghost: "text-peacock hover:bg-peacock-light",
  danger: "bg-white text-vermilion ring-1 ring-inset ring-vermilion/40 hover:bg-vermilion-light",
  // For dark panels (e.g. the peacock hero).
  outlineLight: "bg-transparent text-white ring-1 ring-inset ring-white/60 hover:bg-white/15",
};

const SIZES = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-[15px]", lg: "h-12 px-6 text-base" } as const;

@Component({
  selector: "button[pcButton]",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class]": "cls()",
    "[disabled]": "disabled() || loading()",
    "[attr.aria-busy]": "loading() || null",
  },
  // While busy the button keeps its size: the label stays in place but hidden, under a centred spinner.
  template: `<span [class]="loading() ? 'inline-flex items-center justify-center gap-2 opacity-0' : 'contents'"><ng-content /></span>@if (loading()) {<svg [pcIcon]="Loader2" class="absolute inset-0 m-auto h-4 w-4 animate-spin" />}`,
})
export class Button {
  readonly variant = input<ButtonVariant>("primary");
  readonly size = input<"sm" | "md" | "lg">("md");
  readonly loading = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  protected readonly Loader2 = Loader2;
  protected readonly cls = computed(() =>
    cx("pc-press relative inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55",
      SIZES[this.size()], VARIANTS[this.variant()]),
  );
}

@Component({
  selector: "a[pcButtonLink]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: PcLink, inputs: ["pcLink: href"] }],
  host: { "[class]": "cls()" },
  template: `<ng-content />`,
})
export class ButtonLink {
  readonly variant = input<ButtonVariant>("primary");
  protected readonly cls = computed(() => cx("inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-[15px] font-semibold transition-colors", VARIANTS[this.variant()]));
}

/* ---------------------------------------------------------------- form fields */

let nextId = 0;
/** A unique id for linking labels and controls (React's useId). */
export function uid(prefix = "pc"): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

/** Lets a control inside <pc-field> take the field's id when it has none (React's Field cloned its child for this). */
export const FIELD = new InjectionToken<{ controlId: ReturnType<typeof signal<string>> }>("pc-field");

@Component({
  selector: "pc-field",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: FIELD, useExisting: Field }],
  host: { class: "flex flex-col gap-1" },
  template: `
    <label [attr.for]="htmlFor() || controlId()" class="text-sm font-medium text-ink">{{ label() }}<ng-content select="[label]" /></label>
    <ng-content />
    @if (error()) {
      <p class="text-sm text-vermilion">{{ error() }}</p>
    } @else if (hint()) {
      <p class="text-xs text-ink-faint">{{ hint() }}</p>
    }
  `,
})
export class Field {
  readonly label = input<string>("");
  readonly hint = input<string | null | undefined>(undefined);
  readonly error = input<string | null | undefined>(undefined);
  /** the control's id; when left out, the control inside gets one */
  readonly htmlFor = input<string | undefined>(undefined, { alias: "for" });
  readonly controlId = signal(uid("field"));
}

const inputCls =
  "h-10 rounded-lg border border-line bg-white px-3 text-[15px] text-ink placeholder:text-ink-faint focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20 disabled:bg-mist";

/** Full width unless the caller sets a width (a w-* class of their own). */
function hasWidth(el: HTMLElement): boolean {
  return /(^|\s)(\S+:)*w-/.test(el.getAttribute("class") ?? "");
}

@Directive()
abstract class FieldControl implements OnInit {
  protected readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly field = inject(FIELD, { optional: true });
  protected readonly fullWidth = signal(true);
  ngOnInit(): void {
    this.fullWidth.set(!hasWidth(this.el));
    if (this.field) {
      if (this.el.id) this.field.controlId.set(this.el.id);
      else this.el.id = this.field.controlId();
    }
  }
}

@Directive({
  selector: "input[pcInput]",
  host: { class: inputCls, "[class.w-full]": "fullWidth()", "[class.border-vermilion]": "invalid()" },
})
export class Input extends FieldControl {
  readonly invalid = input(false, { transform: booleanAttribute });
}

@Directive({ selector: "textarea[pcTextarea]", host: { class: `${inputCls} h-auto min-h-[96px] py-2`, "[class.w-full]": "fullWidth()" } })
export class Textarea extends FieldControl {}

@Directive({ selector: "select[pcSelect]", host: { class: `${inputCls} pr-8`, "[class.w-full]": "fullWidth()" } })
export class Select extends FieldControl {}

/** Focuses the element once it is on screen (React's autoFocus). */
@Directive({ selector: "[pcAutofocus]" })
export class Autofocus {
  readonly pcAutofocus = input(true, { transform: (v: unknown) => v !== false && v !== "false" });
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      if (this.pcAutofocus()) el.focus();
    });
  }
}

/** Labelled input that wires id/label automatically. The host is the field (class goes on it, as in the reference). */
@Component({
  selector: "pc-text-field",
  imports: [Input, Autofocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1" },
  template: `
    <label [attr.for]="id" class="text-sm font-medium text-ink">{{ label() }}</label>
    <input pcInput [id]="id" [invalid]="!!error()" [attr.aria-invalid]="!!error()" [type]="type()" [value]="value()" (input)="onInput($event)"
      [attr.placeholder]="placeholder() || null" [attr.autocomplete]="autocomplete() || null" [attr.inputmode]="inputmode() || null"
      [attr.maxlength]="maxlength() ?? null" [attr.minlength]="minlength() ?? null" [attr.name]="name() || null" [required]="required()"
      [disabled]="disabled()" [readOnly]="readonly()" [attr.min]="min() ?? null" [attr.max]="max() ?? null" [attr.step]="step() ?? null"
      [attr.pattern]="pattern() || null" [attr.data-testid]="testid() || null" [pcAutofocus]="autofocus()" (blur)="blurred.emit()" />
    @if (error()) {
      <p class="text-sm text-vermilion">{{ error() }}</p>
    } @else if (hint()) {
      <p class="text-xs text-ink-faint">{{ hint() }}</p>
    }
  `,
})
export class TextField {
  readonly label = input.required<string>();
  readonly hint = input<string | null | undefined>(undefined);
  readonly error = input<string | null | undefined>(undefined);
  readonly value = model<string>("");
  readonly type = input("text");
  readonly placeholder = input<string>("");
  readonly autocomplete = input<string>("");
  readonly inputmode = input<string>("");
  readonly maxlength = input<number | undefined, unknown>(undefined, { transform: (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v)) });
  readonly minlength = input<number | undefined, unknown>(undefined, { transform: (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v)) });
  readonly name = input<string>("");
  readonly required = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly autofocus = input(false, { transform: booleanAttribute });
  readonly min = input<string | number | undefined>(undefined);
  readonly max = input<string | number | undefined>(undefined);
  readonly step = input<string | number | undefined>(undefined);
  readonly pattern = input<string>("");
  readonly testid = input<string>("");
  /** optional filter applied to what is typed (e.g. digits only), like an onChange that rewrites the value */
  readonly filter = input<((v: string) => string) | undefined>(undefined);
  readonly blurred = output<void>();
  protected readonly id = uid("tf");

  protected onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const f = this.filter();
    const v = f ? f(el.value) : el.value;
    if (v !== el.value) el.value = v;
    this.value.set(v);
  }
}

/* ---------------------------------------------------------------- display */

/** Loader2 spinning, in the brand colour; size it with a class (default h-6 w-6 when no h-/w- class is given). */
@Directive({
  selector: "svg[pcSpinner]",
  host: { ...ICON_HOST, class: "lucide animate-spin text-peacock", "aria-label": "Loading" },
})
export class Spinner {
  constructor() {
    const el = inject<ElementRef<SVGSVGElement>>(ElementRef).nativeElement;
    drawIcon(el, Loader2);
    afterNextRender(() => {
      if (!/(^|\s)h-/.test(el.getAttribute("class") ?? "")) el.classList.add("h-6", "w-6");
    });
  }
}

@Component({
  selector: "pc-price",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-wrap items-baseline gap-x-2" },
  template: `
    <span [class]="priceCls()">{{ fmt(price()) }}</span>
    @if (mrp() && mrp()! > price()) {<span [class]="size() === 'lg' ? 'text-ink-faint line-through text-base' : 'text-ink-faint line-through text-sm'">{{ fmt(mrp()!) }}</span>}
    @if (off() > 0) {<span [class]="size() === 'lg' ? 'font-semibold text-leaf text-base' : 'font-semibold text-leaf text-sm'">{{ off() }}% off</span>}
  `,
})
export class Price {
  readonly price = input.required<number>();
  readonly mrp = input<number | undefined>(undefined);
  readonly discount = input<number | undefined>(undefined);
  readonly size = input<"sm" | "md" | "lg">("md");
  protected readonly fmt = rupees;
  protected readonly off = computed(() => {
    const mrp = this.mrp();
    return this.discount() ?? (mrp && mrp > this.price() ? Math.floor(((mrp - this.price()) * 100) / mrp) : 0);
  });
  protected readonly priceCls = computed(() => cx("font-display font-bold text-ink", this.size() === "sm" && "text-base", this.size() === "md" && "text-lg", this.size() === "lg" && "text-3xl"));
}

@Component({
  selector: "pc-rating",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (count()) {
      <span class="inline-flex items-center gap-1.5">
        <span [class]="size() === 'sm' ? 'inline-flex items-center gap-0.5 rounded bg-leaf font-semibold text-white px-1.5 text-xs leading-5' : 'inline-flex items-center gap-0.5 rounded bg-leaf font-semibold text-white px-2 text-sm leading-6'">
          {{ value().toFixed(1) }}<svg [pcIcon]="Star" class="h-3 w-3 fill-current" />
        </span>
        <span class="text-xs text-ink-faint">({{ count()!.toLocaleString("en-IN") }})</span>
      </span>
    }
  `,
})
export class Rating {
  readonly value = input.required<number>();
  readonly count = input<number | undefined>(undefined);
  readonly size = input<"sm" | "md">("sm");
  protected readonly Star = Star;
}

export const PILL_TONE: Record<string, string> = {
  green: "bg-leaf-light text-leaf",
  amber: "bg-marigold-light text-[#8A5A00]",
  red: "bg-vermilion-light text-vermilion",
  blue: "bg-peacock-light text-peacock",
  gray: "bg-mist text-ink-soft",
};
export type PillTone = "green" | "amber" | "red" | "blue" | "gray";

@Component({
  selector: "pc-pill",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()" },
  template: `<ng-content />`,
})
export class Pill {
  readonly tone = input<PillTone | string>("gray");
  protected readonly cls = computed(() => cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", PILL_TONE[this.tone()]));
}

export const STATUS_TONE: Record<string, PillTone> = {
  approved: "green", delivered: "green", paid: "green", processed: "green", active: "green",
  pending: "amber", submitted: "amber", placed: "amber", confirmed: "blue", packed: "blue", shipped: "blue", pending_payment: "amber", cod: "blue",
  rejected: "red", cancelled: "red", suspended: "red", failed: "red", refunded: "gray", partially_refunded: "gray",
  draft: "gray", archived: "gray",
};

@Component({
  selector: "pc-status-pill",
  imports: [Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-pill [tone]="tone()">{{ text() }}</pc-pill>`,
})
export class StatusPill {
  readonly status = input.required<string>();
  readonly label = input<string | undefined>(undefined);
  protected readonly tone = computed(() => STATUS_TONE[this.status()] ?? "gray");
  protected readonly text = computed(() => this.label() ?? this.status().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
}

/** Project the action with the `action` attribute: <pc-empty-state title="..."><a pcButtonLink action href="/">Shop</a></pc-empty-state> */
@Component({
  selector: "pc-empty-state",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center" },
  template: `
    <p class="font-display text-xl font-semibold text-ink">{{ title() }}</p>
    @if (body()) {<p class="max-w-md text-ink-soft">{{ body() }}</p>}
    @if (hasAction()) {<div class="mt-3"><ng-content select="[action]" /></div>}
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly body = input<string | undefined>(undefined);
  /** set false when there is no action (the wrapper div is left out) */
  readonly hasAction = input(true, { transform: booleanAttribute });
}

@Component({
  selector: "pc-error-note",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (message()) {<p role="alert" class="rounded-lg bg-vermilion-light px-3 py-2 text-sm text-vermilion">{{ message() }}</p>}`,
})
export class ErrorNote {
  readonly message = input<string | null | undefined>(undefined);
}

@Component({
  selector: "pc-pagination",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (pages() > 1) {
      <nav class="flex items-center justify-center gap-2 py-4" aria-label="Pages">
        <button pcButton variant="secondary" size="sm" [disabled]="page() <= 1" (click)="pageChange.emit(page() - 1)">Previous</button>
        <span class="text-sm text-ink-soft">Page {{ page() }} of {{ pages() }}</span>
        <button pcButton variant="secondary" size="sm" [disabled]="page() >= pages()" (click)="pageChange.emit(page() + 1)">Next</button>
      </nav>
    }
  `,
})
export class Pagination {
  readonly page = input.required<number, unknown>({ transform: numberAttribute });
  readonly pageSize = input.required<number, unknown>({ transform: numberAttribute });
  readonly total = input.required<number, unknown>({ transform: numberAttribute });
  readonly pageChange = output<number>();
  protected readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
}

/* ---------------------------------------------------------------- modal (PrimeNG Dialog, headless) */

@Component({
  selector: "pc-modal",
  imports: [Dialog, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <p-dialog #dialog class="contents" [visible]="open()" (visibleChange)="!$event && close.emit()" [modal]="true" [closeOnEscape]="true" [dismissableMask]="true"
      [blockScroll]="true" [draggable]="false" [resizable]="false" appendTo="body"
      [maskStyleClass]="'pc-modal-mask fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4'"
      [styleClass]="dialogCls()">
      <ng-template #headless>
        <div class="mb-4 flex items-start justify-between gap-4">
          <!-- the dialog is named by its title (the dialog's aria-labelledby points at this id) -->
          <h2 [id]="dialog.ariaLabelledBy" class="font-display text-xl font-semibold text-ink">{{ title() }}</h2>
          <button type="button" (click)="close.emit()" class="rounded-full p-1 text-ink-soft hover:bg-mist" aria-label="Close">
            <svg [pcIcon]="X" class="h-5 w-5" />
          </button>
        </div>
        <ng-content />
      </ng-template>
    </p-dialog>
  `,
})
export class Modal {
  readonly open = input(false, { transform: booleanAttribute });
  readonly title = input.required<string>();
  readonly wide = input(false, { transform: booleanAttribute });
  readonly close = output<void>();
  protected readonly X = X;
  protected readonly dialogCls = computed(() => cx("max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl", this.wide() ? "sm:max-w-2xl" : "sm:max-w-md"));
}

/* ---------------------------------------------------------------- toast */

type ToastMsg = { id: number; text: string; tone: "ok" | "error" };

/** useToast(): inject(Toast).show(text, tone). The messages are drawn by <pc-toast-host> (in the app root). */
@Injectable({ providedIn: "root" })
export class Toast {
  readonly toasts = signal<ToastMsg[]>([]);
  show(text: string, tone: "ok" | "error" = "ok"): void {
    const id = Date.now() + Math.random();
    this.toasts.update((t) => [...t, { id, text, tone }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), 4000);
  }
}

@Component({
  selector: "pc-toast-host",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6", "aria-live": "polite" },
  template: `
    @for (t of toast.toasts(); track t.id) {
      <div [class]="t.tone === 'ok' ? 'pointer-events-auto rounded-lg px-4 py-2.5 text-[15px] font-medium shadow-lg bg-ink text-white' : 'pointer-events-auto rounded-lg px-4 py-2.5 text-[15px] font-medium shadow-lg bg-vermilion text-white'">{{ t.text }}</div>
    }
  `,
})
export class ToastHost {
  protected readonly toast = inject(Toast);
}

/* ---------------------------------------------------------------- product image */

@Component({
  selector: "pc-product-image",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!src()) {
      <div [class]="'flex items-center justify-center bg-mist text-sm text-ink-faint ' + cls()">No image</div>
    } @else {
      <img [src]="src()" [alt]="alt()" loading="lazy" [class]="'object-contain ' + cls()" />
    }
  `,
})
export class ProductImage {
  readonly src = input<string>("");
  readonly alt = input<string>("");
  /** the reference's className */
  readonly cls = input<string>("", { alias: "imgClass" });
}

export const UI = [Button, ButtonLink, Field, Input, Textarea, Select, Autofocus, TextField, Spinner, Price, Rating, Pill, StatusPill, EmptyState, ErrorNote, Pagination, Modal, ProductImage] as const;
