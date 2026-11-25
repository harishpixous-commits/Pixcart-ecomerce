/*
 * Seller deals: the marketplace's deal rules, the seller's deals by status, a new deal (product, kind, price, time, units,
 * live preview) and stopping a deal. Port of frontend/src/app/seller/deals/page.tsx (NewDealForm included).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { ArrowLeft, Search, Sparkles } from "lucide-angular";
import { ApiError, api, latestOnly, quietly } from "../../core/api";
import { duration, paiseToInput, rupees, toLocalInput, toPaise } from "../../core/format";
import type { DealInfo } from "../../core/types";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { DEAL_KINDS, DEAL_OPEN, DealItem, KIND_ICON, kindText, maxDealMs, type DealKind, type DealRow, type DealRules } from "../../shared/portal/deal-list";
import { DealBadge } from "../../shared/product/product-parts";
import { cx } from "../../shared/ui/cx";
import { Autofocus, Button, EmptyState, ErrorNote, Field, Input, Modal, TextField, Toast } from "../../shared/ui/ui";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";

type Data = { items: DealRow[]; counts: Record<string, number>; rules: DealRules };
type OptVariant = { id: string; label: string; price: number; mrp: number; stock: number; in_deal: boolean };
type OptProduct = { id: string; title: string; image: string; variants: OptVariant[] };

const WANT_MS: Record<DealKind, number> = { lightning: 6 * 3_600_000, deal_of_day: 24 * 3_600_000, limited: 3 * 86_400_000 };
const spanFor = (kind: DealKind, r: DealRules) => Math.min(WANT_MS[kind], maxDealMs(kind, r));

function firstTimes(kind: DealKind, r: DealRules) {
  const start = new Date(Date.now() + 15 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5, 0, 0);
  return { starts: toLocalInput(start), ends: toLocalInput(new Date(start.getTime() + spanFor(kind, r))) };
}

/* ---------------------------------------------------------------- new deal */

@Component({
  selector: "pc-seller-new-deal-form",
  imports: [Icon, Autofocus, Button, ErrorNote, Field, Input, TextField, PageLoader, DealBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-4" data-testid="new-deal-form">
      <pc-error-note [message]="error()" />
      <!-- 1. product -->
      @if (!product()) {
        <div class="flex flex-col gap-2">
          <p class="text-sm font-medium">1. Choose a product</p>
          <div class="relative">
            <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
            <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search your live products" aria-label="Search your live products" class="pl-9" pcAutofocus />
          </div>
          <div class="max-h-72 overflow-y-auto rounded-xl ring-1 ring-line">
            @if (!opts()) {
              <div class="p-6"><pc-page-loader /></div>
            } @else if (opts()!.length === 0) {
              <p class="p-4 text-sm text-ink-soft">{{ q() ? "No live product matches." : "You have no live products yet. Deals run on approved products." }}</p>
            } @else {
              @for (p of opts()!; track p.id) {
                <button type="button" (click)="pick(p)" class="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-0 hover:bg-mist">
                  @if (p.image) {<img [src]="p.image" alt="" class="h-11 w-11 shrink-0 rounded object-contain" />} @else {<span class="h-11 w-11 shrink-0 rounded bg-mist"></span>}
                  <span class="min-w-0 flex-1">
                    <span class="line-clamp-1 font-medium">{{ p.title }}</span>
                    <span class="text-xs text-ink-faint">{{ optLine(p) }}</span>
                  </span>
                </button>
              }
            }
          </div>
        </div>
      } @else {
        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-3 rounded-xl bg-mist p-2.5">
            @if (product()!.image) {<img [src]="product()!.image" alt="" class="h-12 w-12 shrink-0 rounded bg-white object-contain" />}
            <p class="min-w-0 flex-1 font-semibold">{{ product()!.title }}</p>
            <button pcButton type="button" size="sm" variant="ghost" (click)="product.set(null); variantId.set('')"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" /> Change</button>
          </div>
          <fieldset>
            <legend class="mb-1 text-sm font-medium">Version</legend>
            <div class="flex flex-col gap-1.5">
              @for (x of product()!.variants; track x.id) {
                <label [class]="variantCls(x)">
                  <input type="radio" name="deal-variant" class="accent-peacock" [checked]="variantId() === x.id" [disabled]="x.in_deal" (change)="variantId.set(x.id); price.set('')" />
                  <span class="min-w-0 flex-1">
                    <span class="font-medium">{{ x.label }}</span>
                    <span class="block text-xs text-ink-faint">{{ x.stock }} in stock{{ x.in_deal ? " · a deal is running now" : "" }}</span>
                  </span>
                  <span class="text-right text-sm">
                    <span class="font-semibold">{{ rupees(x.price) }}</span>
                    @if (x.mrp > x.price) {<span class="block text-xs text-ink-faint line-through">{{ rupees(x.mrp) }}</span>}
                  </span>
                </label>
              }
            </div>
          </fieldset>
        </div>
      }

      <!-- 2. kind -->
      <fieldset>
        <legend class="mb-1 text-sm font-medium">2. Kind of deal</legend>
        <div class="grid gap-2 sm:grid-cols-3">
          @for (k of kinds; track k) {
            <label [class]="kind() === k ? 'flex cursor-pointer flex-col gap-1 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-peacock/30 border-vermilion bg-vermilion-light/40 ring-1 ring-vermilion' : 'flex cursor-pointer flex-col gap-1 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-peacock/30 border-line hover:bg-mist'">
              <span class="flex items-center gap-2 font-semibold">
                <input type="radio" name="deal-kind" class="sr-only" [checked]="kind() === k" (change)="changeKind(k)" />
                <svg [pcIcon]="kindIcon[k]" class="h-4 w-4 text-vermilion" aria-hidden="true" /> {{ rules().kinds[k] }}
              </span>
              <span class="text-xs text-ink-soft">{{ kindText(k, rules()) }}</span>
            </label>
          }
        </div>
      </fieldset>

      <!-- 3. price, time, units -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <pc-text-field label="3. Deal price (₹)" inputmode="decimal" [(value)]="price" [disabled]="!v()" [hint]="priceHint()" />
          @if (v(); as v) {
            <div class="flex flex-wrap gap-1.5" aria-label="Quick prices">
              @for (p of chips(); track p) {
                <button type="button" (click)="chip(v, p)" [class]="offPrice() === p ? 'rounded-full border px-2.5 py-1 text-xs font-semibold border-vermilion bg-vermilion-light text-vermilion' : 'rounded-full border px-2.5 py-1 text-xs font-semibold border-line hover:bg-mist'">{{ p }}% off</button>
              }
            </div>
          }
        </div>
        @if (kind() === "lightning") {
          <pc-text-field label="Units at the deal price" inputmode="numeric" [(value)]="qty" [filter]="digitsOnly" [disabled]="!v()"
            [hint]="v() ? 'You have ' + v()!.stock + ' in stock. The deal ends when these are claimed.' : 'A lightning deal offers a set number of units'" />
        } @else {
          <pc-field label="Units (optional)" hint="Leave empty to sell at the deal price until the deal ends">
            <input pcInput inputmode="numeric" [value]="qty()" (input)="onQty($event)" [disabled]="!v()" />
          </pc-field>
        }
        <pc-text-field label="Starts" type="datetime-local" [value]="times().starts" (valueChange)="changeStart($event)" />
        <pc-text-field label="Ends" type="datetime-local" [value]="times().ends" (valueChange)="setEnds($event)" [error]="endsError()" [hint]="endsHint()" />
      </div>

      @if (preview(); as preview) {
        <div class="rounded-xl border border-dashed border-vermilion/40 bg-vermilion-light/20 p-3" data-testid="deal-preview">
          <p class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint"><svg [pcIcon]="Sparkles" class="h-3.5 w-3.5" aria-hidden="true" /> How shoppers will see it</p>
          <p>
            <span class="font-display text-2xl font-bold">{{ rupees(pricePaise()) }}</span>{{ " " }}
            @if (v()!.mrp > pricePaise()) {<span class="text-sm text-ink-faint">M.R.P. <span class="line-through">{{ rupees(v()!.mrp) }}</span></span>}
          </p>
          <div class="mt-1 max-w-xs"><pc-deal-badge [deal]="preview" [discount]="offMrp()" /></div>
          @if (pricePaise() > maxPrice()) {<p class="mt-2 text-sm text-vermilion">Lower the price to {{ rupees(maxPrice()) }} or less to meet the {{ rules().min_discount_pct }}% rule.</p>}
        </div>
      }

      <div class="flex flex-wrap items-center gap-3">
        <button pcButton type="submit" [loading]="saving()" [disabled]="!v()">{{ rules().need_approval ? "Send for approval" : "Schedule deal" }}</button>
        <p class="text-xs text-ink-faint">{{ rules().need_approval ? "You get a notification when it is approved." : "It starts at the time you chose." }}</p>
      </div>
    </form>
  `,
})
export class SellerNewDealForm {
  readonly rules = input.required<DealRules>();
  readonly done = output<string>();
  protected readonly Search = Search;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Sparkles = Sparkles;
  protected readonly kinds = DEAL_KINDS;
  protected readonly kindIcon = KIND_ICON;
  protected readonly kindText = kindText;
  protected readonly rupees = rupees;
  protected readonly digitsOnly = (v: string) => v.replace(/\D/g, "");

  protected readonly q = signal("");
  protected readonly opts = signal<OptProduct[] | null>(null);
  protected readonly product = signal<OptProduct | null>(null);
  protected readonly variantId = signal("");
  protected readonly kind = signal<DealKind>("lightning");
  protected readonly price = signal("");
  protected readonly times = signal<{ starts: string; ends: string }>({ starts: "", ends: "" });
  protected readonly qty = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  private readonly track = latestOnly();
  private started = false;

  protected readonly v = computed(() => this.product()?.variants.find((x) => x.id === this.variantId()) ?? null);
  protected readonly maxPrice = computed(() => {
    const v = this.v();
    return v ? Math.floor((v.price * (100 - this.rules().min_discount_pct)) / 100) : 0;
  });
  protected readonly pricePaise = computed(() => toPaise(this.price()) ?? 0);
  private readonly startMs = computed(() => new Date(this.times().starts).getTime());
  private readonly endMs = computed(() => new Date(this.times().ends).getTime());
  private readonly span = computed(() => this.endMs() - this.startMs());
  private readonly maxMs = computed(() => maxDealMs(this.kind(), this.rules()));
  protected readonly offMrp = computed(() => {
    const v = this.v();
    const p = this.pricePaise();
    return v && v.mrp > 0 && p > 0 ? Math.round((100 * (v.mrp - p)) / v.mrp) : 0;
  });
  protected readonly offPrice = computed(() => {
    const v = this.v();
    const p = this.pricePaise();
    return v && p > 0 ? Math.round((100 * (v.price - p)) / v.price) : 0;
  });
  protected readonly chips = computed(() => {
    const min = this.rules().min_discount_pct;
    return Array.from(new Set([min, 15, 20, 25, 30, 40, 50])).filter((p) => p >= min && p < 95).sort((a, b) => a - b).slice(0, 5);
  });
  protected readonly priceHint = computed(() => {
    const v = this.v();
    return v ? `Now ${rupees(v.price)}. ${rupees(this.maxPrice())} or less (at least ${this.rules().min_discount_pct}% off).` : "Choose a version first";
  });
  protected readonly endsError = computed(() => {
    const span = this.span();
    return span > this.maxMs() ? `Too long: at most ${duration(this.maxMs())}` : span <= 0 && !Number.isNaN(span) ? "Must be after the start" : undefined;
  });
  protected readonly endsHint = computed(() => (this.span() > 0 ? `Runs for ${duration(this.span())} (at most ${duration(this.maxMs())})` : undefined));
  protected readonly preview = computed<DealInfo | null>(() => {
    const v = this.v();
    const p = this.pricePaise();
    const kind = this.kind();
    return v && p > 0 && !Number.isNaN(this.endMs()) ? {
      kind, label: this.rules().kinds[kind], ends_at: new Date(this.endMs()).toISOString(), deal_price: p, regular_price: v.price,
      claimed_pct: kind === "lightning" ? 0 : null, variant_id: v.id,
    } as DealInfo : null;
  });

  constructor() {
    effect(() => {
      // the first suggested times come from the rules (useState initialiser in the reference)
      const r = this.rules();
      if (!this.started) {
        this.started = true;
        this.times.set(firstTimes("lightning", r));
      }
    });
    effect((onCleanup) => {
      const q = this.q();
      const t = setTimeout(() => {
        this.track(api<{ products: OptProduct[] }>("/api/seller/deals/options", { query: { q: q.trim() || undefined } }), (x) => this.opts.set(x.products)).catch(quietly);
      }, q ? 250 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected optLine(p: OptProduct): string {
    return `${p.variants.length === 1 ? rupees(p.variants[0].price) : `${p.variants.length} versions`}${p.variants.some((x) => x.in_deal) ? " · a deal is running" : ""}`;
  }

  protected variantCls(x: OptVariant): string {
    return cx("flex items-center gap-3 rounded-lg border px-3 py-2", x.in_deal ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      this.variantId() === x.id ? "border-peacock bg-peacock-light/40" : "border-line hover:bg-mist");
  }

  protected pick(p: OptProduct): void {
    this.product.set(p);
    const open = p.variants.filter((x) => !x.in_deal);
    this.variantId.set(open.length === 1 ? open[0].id : "");
    this.price.set("");
    this.error.set(null);
  }

  protected chip(v: OptVariant, p: number): void {
    this.price.set(paiseToInput(Math.floor((v.price * (100 - p)) / 100 / 100) * 100));
  }

  protected onQty(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/\D/g, "");
    if (v !== el.value) el.value = v;
    this.qty.set(v);
  }

  protected changeKind(k: DealKind): void {
    this.kind.set(k);
    const s = this.startMs();
    if (!Number.isNaN(s)) this.times.set({ starts: this.times().starts, ends: toLocalInput(new Date(s + spanFor(k, this.rules()))) });
  }

  protected changeStart(value: string): void {
    const s = new Date(value).getTime();
    const span = this.span();
    // keep the same length when the start moves
    this.times.set({ starts: value, ends: !Number.isNaN(s) && span > 0 ? toLocalInput(new Date(s + span)) : this.times().ends });
  }

  protected setEnds(value: string): void {
    this.times.update((t) => ({ ...t, ends: value }));
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    const v = this.v();
    const rules = this.rules();
    const kind = this.kind();
    const pricePaise = this.pricePaise();
    const startMs = this.startMs();
    const endMs = this.endMs();
    const span = this.span();
    const maxMs = this.maxMs();
    if (!v) return void this.error.set("Choose the product version for the deal");
    if (!pricePaise) return void this.error.set("Enter the deal price");
    if (pricePaise > this.maxPrice()) return void this.error.set(`The deal price must be ${rupees(this.maxPrice())} or less (at least ${rules.min_discount_pct}% below ${rupees(v.price)})`);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return void this.error.set("Choose when the deal starts and ends");
    if (span <= 0) return void this.error.set("The deal must end after it starts");
    if (span > maxMs) return void this.error.set(`A ${rules.kinds[kind].toLowerCase()} can run for at most ${duration(maxMs)}`);
    const units = Number(this.qty());
    if (kind === "lightning" && (!units || units < 1)) return void this.error.set("Enter how many units you offer at the deal price");
    if (kind === "lightning" && units > v.stock) return void this.error.set(`You have ${v.stock} in stock; offer at most that many units`);
    this.saving.set(true);
    try {
      const out = await api<DealRow>("/api/seller/deals", { method: "POST", body: {
        variant_id: v.id, kind, deal_price_paise: pricePaise, starts_at: new Date(startMs).toISOString(), ends_at: new Date(endMs).toISOString(),
        qty_limit: units > 0 ? units : null,
      } });
      this.done.emit(out.status);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not create the deal");
    } finally {
      this.saving.set(false);
    }
  }
}

/* ---------------------------------------------------------------- page */

@Component({
  selector: "pc-seller-deals-page",
  imports: [PageHeader, Tabs, DealItem, Icon, Button, EmptyState, ErrorNote, Modal, PageLoader, SellerNewDealForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Deals" sub="Put a product in Today's Deals with a lower price for a limited time. While the deal runs, shoppers see the deal price, a countdown and the deal badge." [withActions]="true">
        <button actions pcButton (click)="creating.set(true)" [disabled]="!rules()?.enabled">New deal</button>
      </pc-page-header>
      <pc-error-note [message]="error()" />
      @if (d(); as d) {
        @if (!d.rules.enabled) {
          <p class="mb-4 rounded-xl bg-marigold-light px-4 py-3 text-sm">Deals are switched off on the marketplace right now. Your running deals have ended; you can still see them here.</p>
        } @else {
          <section class="mb-4 rounded-xl bg-white p-4" aria-label="Deal rules">
            <div class="grid gap-4 sm:grid-cols-3">
              @for (k of kinds; track k) {
                <div class="flex gap-3">
                  <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-vermilion-light text-vermilion"><svg [pcIcon]="kindIcon[k]" class="h-5 w-5" aria-hidden="true" /></span>
                  <div>
                    <p class="font-semibold">{{ d.rules.kinds[k] }}</p>
                    <p class="text-sm text-ink-soft">{{ kindText(k, d.rules) }}</p>
                  </div>
                </div>
              }
            </div>
            <p class="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
              The deal price must be at least <b class="text-ink">{{ d.rules.min_discount_pct }}%</b> below your current selling price.{{ " " }}{{ d.rules.need_approval ? "The marketplace team checks each deal before it starts." : "Deals start on time without a review." }}{{ " " }}While a deal runs you cannot change that version&apos;s price; the price goes back by itself when the deal ends.
            </p>
          </section>
        }
        <pc-tabs [value]="status()" (valueChange)="status.set($event)" [items]="tabs()" />
        @if (d.items.length === 0) {
          <pc-empty-state [title]="status() ? 'No deals here' : 'No deals yet'"
            [body]="status() ? 'Deals in this state show up here.' : 'Create a deal to get your product into Today\\'s Deals with a countdown and a deal badge.'"
            [hasAction]="!status() && d.rules.enabled">
            <button action pcButton (click)="creating.set(true)">Create your first deal</button>
          </pc-empty-state>
        } @else {
          <div class="flex flex-col gap-3">
            @for (x of d.items; track x.id) {
              <pc-deal-item [d]="x" [withActions]="open.includes(x.status)">
                @if (open.includes(x.status)) {
                  <button actions pcButton size="sm" variant="danger" (click)="stop.set(x)">{{ x.status === "active" ? "Stop deal" : "Cancel deal" }}</button>
                }
              </pc-deal-item>
            }
          </div>
        }
      } @else if (!error()) {
        <pc-page-loader />
      }

      <pc-modal [open]="creating() && !!rules()" (close)="creating.set(false)" title="New deal" [wide]="true">
        @if (rules(); as rules) {
          <pc-seller-new-deal-form [rules]="rules" (done)="created($event)" />
        }
      </pc-modal>

      <pc-modal [open]="stop() !== null" (close)="stop.set(null)" [title]="stop()?.status === 'active' ? 'Stop this deal?' : 'Cancel this deal?'">
        @if (stop(); as stop) {
          <div class="flex flex-col gap-3">
            <p class="text-ink-soft">
              <span class="font-semibold text-ink">{{ stop.product }}</span> ({{ stop.variant }}).{{ " " }}{{ stop.status === "active" ? "The price goes back to " + rupees(stop.regular_price) + " right away and the deal badge is removed." : "The deal will not start." }}
            </p>
            <div class="flex gap-2">
              <button pcButton variant="danger" (click)="cancelDeal()" [loading]="busy()">{{ stop.status === "active" ? "Stop deal" : "Cancel deal" }}</button>
              <button pcButton variant="ghost" (click)="this.stop.set(null)">Keep it</button>
            </div>
          </div>
        }
      </pc-modal>
    </div>
  `,
})
export class SellerDealsPage {
  private readonly toast = inject(Toast);
  protected readonly kinds = DEAL_KINDS;
  protected readonly kindIcon = KIND_ICON;
  protected readonly kindText = kindText;
  protected readonly open = DEAL_OPEN;
  protected readonly rupees = rupees;
  protected readonly status = signal("");
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly stop = signal<DealRow | null>(null);
  protected readonly busy = signal(false);
  protected readonly rules = computed(() => this.d()?.rules);
  protected readonly tabs = computed(() => {
    const rules = this.rules();
    const counts = this.d()?.counts ?? {};
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    return [
      { value: "", label: "All", count: all },
      { value: "active", label: "Running", count: counts["active"] ?? 0 },
      { value: "approved", label: "Scheduled", count: counts["approved"] ?? 0 },
      ...(rules?.need_approval || counts["pending"] ? [{ value: "pending", label: "Waiting for approval", count: counts["pending"] ?? 0 }] : []),
      { value: "ended", label: "Ended", count: counts["ended"] ?? 0 },
      { value: "rejected", label: "Not approved", count: counts["rejected"] ?? 0 },
      { value: "cancelled", label: "Cancelled", count: counts["cancelled"] ?? 0 },
    ];
  });
  private readonly track = latestOnly();

  constructor() {
    effect(() => {
      this.status();
      this.load();
    });
  }

  private load(): void {
    this.track(api<Data>("/api/seller/deals", { query: { status: this.status() || undefined } }), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load your deals"));
  }

  protected created(st: string): void {
    this.creating.set(false);
    this.toast.show(st === "pending" ? "Deal sent. The marketplace team will check it before it starts." : "Deal scheduled. It starts on time.");
    const next = st === "pending" ? "pending" : st === "active" ? "active" : "approved";
    if (next === this.status()) this.load();
    else this.status.set(next);
  }

  protected async cancelDeal(): Promise<void> {
    const stop = this.stop();
    if (!stop) return;
    this.busy.set(true);
    try {
      await api(`/api/seller/deals/${stop.id}/cancel`, { method: "POST" });
      this.toast.show(stop.status === "active" ? "Deal stopped. The price is back to normal." : "Deal cancelled");
      this.stop.set(null);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not cancel the deal", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
