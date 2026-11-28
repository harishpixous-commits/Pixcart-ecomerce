/*
 * Coupon list and editor shared by the seller hub (seller-funded) and the admin (platform-funded).
 * Port of components/coupons.tsx: <pc-coupon-manager base="/api/seller/coupons" [admin]="false" />
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { date, paiseToInput, rupees, toLocalInput, toPaise } from "../../core/format";
import { PageHeader, Table } from "../portal-shell";
import { PageLoader } from "../ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Modal, Pill, Select, TextField, Toast } from "../ui/ui";

export type CouponRow = {
  id: string; code: string; description: string; kind: "percent" | "flat"; value: number; max_discount_paise: number | null; min_order_paise: number;
  starts_at: string | null; ends_at: string | null; usage_limit: number | null; per_user_limit: number; used_count: number; funded_by: string;
  category_id: string | null; first_order_only: boolean; is_active: boolean; show_on_checkout: boolean; is_automatic?: boolean;
};

export function couponSummary(c: Pick<CouponRow, "kind" | "value" | "max_discount_paise" | "min_order_paise">) {
  const off = c.kind === "percent" ? `${c.value / 100}% off` : `${rupees(c.value)} off`;
  const cap = c.kind === "percent" && c.max_discount_paise ? ` up to ${rupees(c.max_discount_paise)}` : "";
  const min = c.min_order_paise ? ` on ${rupees(c.min_order_paise)} or more` : "";
  return off + cap + min;
}

// The form shows the browser's local time; toISOString() would show UTC and shift the time on every save.
const toLocal = (iso: string | null) => toLocalInput(iso);

const BLANK = { code: "", description: "", kind: "percent", value: "10", max: "", min: "", starts: "", ends: "", limit: "", per_user: "1", category_id: "", first_order_only: false, show_on_checkout: true, is_automatic: false, is_active: true };
type Form = typeof BLANK;

const digits = (v: string) => v.replace(/\D/g, "");
const codeChars = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

@Component({
  selector: "pc-coupon-manager",
  imports: [PageHeader, Table, PageLoader, Button, EmptyState, ErrorNote, Field, Modal, Pill, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Coupons" [sub]="admin() ? 'Platform-funded offers: the discount comes out of the platform\\'s commission, sellers are paid on the full price.' : 'Your own offers: the discount is taken from your sale value, and commission and tax are on the discounted price.'" [withActions]="true">
      <button actions pcButton (click)="open('new')">New coupon</button>
    </pc-page-header>
    @if (!rows()) {
      <pc-page-loader />
    } @else if (rows()!.length === 0) {
      <pc-empty-state title="No coupons yet" body="Create a coupon to run a sale or welcome new customers." [hasAction]="false" />
    } @else {
      <pc-table [head]="head()">
        @for (c of rows(); track c.id) {
          <tr class="cursor-pointer hover:bg-mist/60" (click)="open(c)">
            <td class="px-4 py-2.5"><p class="font-semibold text-peacock">{{ c.code }}</p><p class="text-sm text-ink-faint">{{ c.description }}</p></td>
            <td class="px-4 py-2.5 text-sm">{{ summary(c) }}{{ c.first_order_only ? ", first order only" : "" }}</td>
            <td class="px-4 py-2.5 text-sm">{{ c.starts_at ? date(c.starts_at) : "Now" }} to {{ c.ends_at ? date(c.ends_at) : "no end" }}</td>
            <td class="px-4 py-2.5 text-sm">{{ c.used_count }}{{ c.usage_limit ? " of " + c.usage_limit : "" }}</td>
            @if (admin()) {<td class="px-4 py-2.5 text-sm">{{ c.funded_by === "seller" ? "Seller" : "Platform" }}</td>}
            <td class="px-4 py-2.5">
              @switch (state(c)) {
                @case ("off") {<pc-pill tone="gray">Off</pc-pill>}
                @case ("ended") {<pc-pill tone="red">Ended</pc-pill>}
                @case ("scheduled") {<pc-pill tone="blue">Scheduled</pc-pill>}
                @case ("used") {<pc-pill tone="red">Used up</pc-pill>}
                @default {<pc-pill tone="green">Live</pc-pill>}
              }
            </td>
          </tr>
        }
      </pc-table>
    }
    <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="modalTitle()" [wide]="true">
      @if (sellerOwned()) {
        <p class="text-ink-soft">This coupon belongs to a seller. Sellers manage their own coupons.</p>
      } @else {
        <form (submit)="save($event)" class="grid gap-3 sm:grid-cols-2">
          <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>
          <pc-text-field label="Code" [value]="f().code" (valueChange)="set('code', $event)" [filter]="codeChars" [required]="true" [minlength]="4" [maxlength]="30" [disabled]="edit() !== 'new'" hint="Letters and numbers, e.g. DIWALI20" />
          <pc-text-field label="Short description" [value]="f().description" (valueChange)="set('description', $event)" [maxlength]="200" hint="Shown to customers at checkout" />
          <pc-field label="Discount type" for="ck">
            <select pcSelect id="ck" (change)="set('kind', $any($event.target).value)">
              <option value="percent" [selected]="f().kind === 'percent'">Percentage</option><option value="flat" [selected]="f().kind === 'flat'">Fixed amount</option>
            </select>
          </pc-field>
          <pc-text-field [label]="f().kind === 'percent' ? 'Percentage off (1 to 90)' : 'Amount off (₹)'" inputmode="decimal" [value]="f().value" (valueChange)="set('value', $event)" [required]="true" />
          @if (f().kind === "percent") {<pc-text-field label="Maximum discount (₹, optional)" inputmode="decimal" [value]="f().max" (valueChange)="set('max', $event)" />}
          <pc-text-field label="Minimum order (₹, optional)" inputmode="decimal" [value]="f().min" (valueChange)="set('min', $event)" [hint]="admin() ? 'Counted on the whole cart' : 'Counted on your items in the cart'" />
          <pc-text-field label="Starts" type="datetime-local" [value]="f().starts" (valueChange)="set('starts', $event)" />
          <pc-text-field label="Ends" type="datetime-local" [value]="f().ends" (valueChange)="set('ends', $event)" />
          <pc-text-field label="Total uses allowed (optional)" inputmode="numeric" [value]="f().limit" (valueChange)="set('limit', $event)" [filter]="digits" />
          <pc-text-field label="Uses per customer" inputmode="numeric" [value]="f().per_user" (valueChange)="set('per_user', $event)" [filter]="digits" />
          @if (admin()) {
            <pc-field label="Only for a category (optional)" for="cc" class="sm:col-span-2">
              <select pcSelect id="cc" (change)="set('category_id', $any($event.target).value)">
                <option value="" [selected]="f().category_id === ''">All categories</option>
                @for (c of cats(); track c.id) {<option [value]="c.id" [selected]="c.id === f().category_id">{{ c.path ?? c.name }}</option>}
              </select>
            </pc-field>
            <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="f().first_order_only" (change)="set('first_order_only', $any($event.target).checked)" /> First order only</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="f().show_on_checkout" (change)="set('show_on_checkout', $any($event.target).checked)" /> Show in the offers list at checkout</label>
            <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="f().is_automatic" (change)="set('is_automatic', $any($event.target).checked)" /> Apply automatically, no code needed (needs Growth, Automatic discounts, switched on)</label>
          }
          <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="accent-peacock" [checked]="f().is_active" (change)="set('is_active', $any($event.target).checked)" /> Coupon is on</label>
          <button pcButton type="submit" class="self-start">Save coupon</button>
          @if (admin() && editRow(); as row) {
            <div class="rounded-lg border border-line p-3 sm:col-span-2" data-testid="coupon-batch">
              <p class="font-semibold">Make copies with their own codes</p>
              <p class="mb-2 text-sm text-ink-soft">Each copy has the same offer and a random code. Single-use copies work once in total and stay off the offers list. Save any changes above first.</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <pc-text-field label="How many (1 to 200)" inputmode="numeric" [value]="batchCount()" (valueChange)="batchCount.set($event)" [filter]="digits" />
                <pc-text-field label="Code starts with" [value]="batchPrefix()" (valueChange)="batchPrefix.set($event)" [filter]="codeChars" [maxlength]="10" />
                <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="accent-peacock" [checked]="batchSingle()" (change)="batchSingle.set($any($event.target).checked)" /> Single use each</label>
              </div>
              <button pcButton type="button" class="mt-2" (click)="makeCopies(row.id)">Make codes</button>
              @if (batchCodes()) {<textarea readonly rows="6" class="mt-2 w-full rounded-lg border border-line p-2 font-mono text-sm" aria-label="New codes" [value]="batchCodes()"></textarea>}
            </div>
          }
        </form>
      }
    </pc-modal>
  `,
})
export class CouponManager {
  readonly base = input.required<string>();
  readonly admin = input(false);
  private readonly toast = inject(Toast);
  private readonly now = Date.now();
  protected readonly date = date;
  protected readonly summary = couponSummary;
  protected readonly digits = digits;
  protected readonly codeChars = codeChars;
  protected readonly rows = signal<CouponRow[] | null>(null);
  protected readonly edit = signal<CouponRow | "new" | null>(null);
  protected readonly cats = signal<{ id: string; path?: string; name?: string }[]>([]);
  protected readonly f = signal<Form>({ ...BLANK });
  protected readonly error = signal<string | null>(null);
  protected readonly head = computed(() => ["Code", "Offer", "Valid", "Used", this.admin() ? "Funded by" : "", "Status"].filter(Boolean));
  protected readonly modalTitle = computed(() => {
    const e = this.edit();
    return e === "new" ? "New coupon" : `Edit ${(e as CouponRow | null)?.code ?? ""}`;
  });
  protected readonly batchCount = signal("10");
  protected readonly batchPrefix = signal("");
  protected readonly batchSingle = signal(true);
  protected readonly batchCodes = signal("");
  protected readonly editRow = computed(() => {
    const e = this.edit();
    return e && e !== "new" ? e : null;
  });
  protected readonly sellerOwned = computed(() => {
    const e = this.edit();
    return !!e && e !== "new" && e.funded_by === "seller" && this.admin();
  });

  constructor() {
    effect(() => {
      this.base();
      this.load();
      if (this.admin()) api<{ id: string; path?: string; name?: string }[]>("/api/admin/categories").then((c) => this.cats.set(c)).catch(() => {});
    });
  }

  private load(): void {
    api<CouponRow[]>(this.base()).then((r) => this.rows.set(r)).catch(quietly);
  }

  protected set<K extends keyof Form>(k: K, v: Form[K]): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected state(c: CouponRow): string {
    return !c.is_active ? "off"
      : c.ends_at && new Date(c.ends_at).getTime() < this.now ? "ended"
      : c.starts_at && new Date(c.starts_at).getTime() > this.now ? "scheduled"
      : c.usage_limit && c.used_count >= c.usage_limit ? "used"
      : "live";
  }

  protected open(c: CouponRow | "new"): void {
    this.error.set(null);
    this.edit.set(c);
    if (c === "new") this.f.set({ ...BLANK });
    else this.f.set({
      code: c.code, description: c.description, kind: c.kind, value: c.kind === "percent" ? String(c.value / 100) : paiseToInput(c.value),
      max: c.max_discount_paise ? paiseToInput(c.max_discount_paise) : "", min: c.min_order_paise ? paiseToInput(c.min_order_paise) : "",
      starts: toLocal(c.starts_at), ends: toLocal(c.ends_at), limit: c.usage_limit ? String(c.usage_limit) : "", per_user: String(c.per_user_limit),
      category_id: c.category_id ?? "", first_order_only: c.first_order_only, show_on_checkout: c.show_on_checkout, is_automatic: !!c.is_automatic, is_active: c.is_active,
    });
  }

  protected async makeCopies(id: string): Promise<void> {
    try {
      const r = await api<{ count: number; codes: string[] }>(`${this.base()}/${id}/generate`, {
        method: "POST", body: { count: Number(this.batchCount()), prefix: this.batchPrefix(), single_use: this.batchSingle() },
      });
      this.batchCodes.set(r.codes.join("\n"));
      this.toast.show(`${r.count} codes made`);
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not make the codes", "error");
    }
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    const f = this.f();
    const value = f.kind === "percent" ? Math.round(Number(f.value) * 100) : toPaise(f.value);
    if (!value || value <= 0) return void this.error.set("Enter the discount");
    const body: Record<string, unknown> = {
      code: f.code, description: f.description, kind: f.kind, value,
      max_discount_paise: f.kind === "percent" && f.max ? toPaise(f.max) : null, min_order_paise: f.min ? toPaise(f.min) ?? 0 : 0,
      starts_at: f.starts ? new Date(f.starts).toISOString() : null, ends_at: f.ends ? new Date(f.ends).toISOString() : null,
      usage_limit: f.limit ? Number(f.limit) : null, per_user_limit: Number(f.per_user) || 1, is_active: f.is_active,
    };
    if (this.admin()) Object.assign(body, { category_id: f.category_id || null, first_order_only: f.first_order_only, show_on_checkout: f.show_on_checkout, is_automatic: f.is_automatic });
    try {
      const edit = this.edit();
      if (edit === "new") await api(this.base(), { method: "POST", body });
      else await api(`${this.base()}/${(edit as CouponRow).id}`, { method: "PUT", body });
      this.toast.show("Coupon saved");
      this.edit.set(null);
      this.load();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    }
  }
}
