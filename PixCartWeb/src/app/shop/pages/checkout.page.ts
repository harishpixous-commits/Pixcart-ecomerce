/*
 * Checkout: delivery address and instructions, the items by seller, "Did you forget?", coupons, a tip for the delivery
 * partner, a GSTIN for business purchases, "no bag", the bill, how to pay and the pay button. On desktop the bill and
 * the pay button sit in a sticky right-hand column; on phones and tablets a slide-to-pay bar stays at the bottom.
 *
 * Every amount comes from the server's quote. The quote is asked for again whenever something that changes it changes
 * (address, payment method, coupon, tip, the cart), and only the newest answer is applied.
 * Port of frontend/src/app/(shop)/checkout/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { Lock, MapPin, ShieldCheck } from "lucide-angular";
import { ApiError, api, latestOnly } from "../../core/api";
import { rupees } from "../../core/format";
import { RegionalService } from "../../core/regional";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { Address, CartView, CheckoutPayload, OrderDetail, ProductCard } from "../../core/types";
import { BillDetails } from "../../shared/commerce/bill";
import { ProductRail } from "../../shared/product/product";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ButtonLink, EmptyState, ErrorNote, Toast } from "../../shared/ui/ui";
import { AddressSection } from "../checkout/address";
import { CARD } from "../checkout/card";
import { BusinessSection, GiftMessageSection, InstructionsSection, NoBagSection, TipSection, businessErrors } from "../checkout/extras";
import { CouponSection, type OfferCoupon } from "../checkout/offers";
import { CancellationNote, PayBar, PaymentMethods, type PayMethod } from "../checkout/payment";
import { BillSkeleton, ItemsReview, ReviewSkeleton } from "../checkout/review";

type Quote = CartView & {
  coupon: { code: string; discount: number; description?: string; error: string | null } | null;
  /** The chosen address's saved delivery instructions (and map pin). */
  address?: { instructions: string; lat: number | null; lng: number | null };
  address_id?: string;
};
type QuoteBody = { address_id: string; payment_method: PayMethod; coupon_code: string | null; tip_paise: number };
type QuoteResult = { ok: true; quote: Quote } | { ok: false; error: unknown };

function newIdempotencyKey() {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
}

/** What a quote was worked out for. The bill on screen is current when its key matches the choices on screen. */
function quoteKey(body: QuoteBody, cartCount: number): string {
  return [body.address_id, body.payment_method, body.coupon_code ?? "", body.tip_paise, cartCount].join("|");
}

function scrollToSection(id: string, focusSelector?: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  if (focusSelector) el.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
}

@Component({
  selector: "pc-shop-checkout-page",
  imports: [
    Icon, PageLoader, Button, ButtonLink, EmptyState, ErrorNote, BillDetails, ProductRail, AddressSection, InstructionsSection, ItemsReview, ReviewSkeleton,
    BillSkeleton, CouponSection, TipSection, BusinessSection, NoBagSection, GiftMessageSection, CancellationNote, PaymentMethods, PayBar,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.ready() || !session.user()) {
      <pc-page-loader />
    } @else if (addresses() === null) {
      @if (!loadError()) {
        <pc-page-loader />
      } @else {
        <div class="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
          <pc-error-note [message]="loadError()" />
          <button pcButton variant="secondary" (click)="retryAddresses()">Try again</button>
        </div>
      }
    } @else if (quote() && quote()!.groups.length === 0 && !done()) {
      <pc-empty-state title="Your cart is empty" body="Add something you like, then come back here to check out."><a pcButtonLink href="/" action>Start shopping</a></pc-empty-state>
    } @else {
      <div>
        <div class="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
          <h1 class="font-display text-2xl font-bold text-ink sm:text-[28px]">Checkout</h1>
          <p class="flex items-center gap-1.5 text-sm font-semibold text-leaf"><svg [pcIcon]="ShieldCheck" class="h-4 w-4" /> Safe and secure payments</p>
        </div>

        <div class="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-x-6">
          <div class="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
            <pc-address-section [addresses]="addresses()!" [selectedId]="addressId()" (select)="addressId.set($event); error.set(null)" [adding]="adding()"
              (add)="adding.set(true)" [cancellable]="addresses()!.length > 0" (cancelAdd)="adding.set(false)" (saved)="onSaved($event)" />

            @if (opts()?.instructions_enabled && addressId() && !adding()) {
              <pc-instructions-section [text]="noteText()" (textChange)="setNote($event)" [save]="saveNote()" (saveChange)="saveNote.set($event)" />
            }

            @if (quote(); as q) {
              <pc-items-review [groups]="q.groups" [itemCount]="q.summary.item_count" />
            } @else if (addressId()) {
              <pc-review-skeleton />
            }

            @if (related().length > 0) {
              <!-- Wider product tiles than the rail's own full-width sizes, since here it sits in the narrower left column. -->
              <div class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 lg:[&_.snap-start]:w-1/3 xl:[&_.snap-start]:w-1/4" data-testid="checkout-forgot">
                <pc-product-rail title="Did you forget?" note="Often added with your items" [items]="related()" [showAdd]="true" />
              </div>
            }

            @if (site().features.coupons && quote(); as q) {
              <pc-coupon-section [applied]="q.coupon && !q.coupon.error ? q.coupon : null" [error]="couponError()" [offers]="offers()"
                [checking]="quoting() && coupon() !== null" (apply)="couponError.set(null); coupon.set($event)" (remove)="coupon.set(null); couponError.set(null)"
                (edit)="couponError.set(null)" />
            }

            @if (opts()?.tip_enabled) {
              <pc-tip-section [presets]="opts()!.tip_presets" [max]="opts()!.tip_max_paise" [tip]="tip()" (tipChange)="tip.set($event)" />
            }

            @if (opts()?.gstin_enabled) {
              <pc-business-section [gstin]="gstin()" [business]="business()" (gstinChange)="gstin.set($event); bizServerError.set(null)"
                (businessChange)="business.set($event); bizServerError.set(null)" [open]="bizOpen()" (openChange)="bizOpen.set($event)"
                [showErrors]="bizChecked()" [serverError]="bizServerError()" />
            }

            @if (opts()?.gift_message_enabled) {
              <pc-gift-message-section [text]="gift()" [max]="opts()?.gift_message_max ?? 150" (textChange)="gift.set($event)" />
            }

            @if (opts()?.no_bag_enabled) {
              <pc-no-bag-section [on]="noBag()" (onChange)="noBag.set($event)" />
            }
          </div>

          <aside class="flex min-w-0 flex-col gap-4 lg:sticky lg:top-36 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start" aria-label="Bill and payment">
            <div [class]="CARD + ' flex flex-col gap-4'" data-testid="checkout-bill">
              @if (quote(); as q) {
                <div [attr.aria-busy]="quoting() || null" [class]="quoting() ? 'transition-opacity duration-200 opacity-60' : 'transition-opacity duration-200'">
                  <pc-bill-details [bill]="billOf(q)" [deliveryLabel]="q.checkout?.delivery_label" [deliveryInfo]="q.checkout?.delivery_info" [hints]="q.hints ?? []" totalLabel="To pay" />
                </div>
              } @else if (!addressId()) {
                <p class="flex items-center gap-2 text-sm text-ink-soft"><svg [pcIcon]="MapPin" class="h-4 w-4 shrink-0 text-peacock" /> Add a delivery address to see your bill.</p>
              } @else if (!quoteError()) {
                <pc-bill-skeleton />
              }
              @if (quoteError()) {
                <div class="flex flex-col items-start gap-2">
                  <pc-error-note [message]="quoteError()" />
                  <button pcButton variant="ghost" size="sm" (click)="retryQuote()">Try again</button>
                </div>
              }
              <div class="hidden flex-col gap-3 border-t border-line pt-4 lg:flex">
                <pc-error-note [message]="error()" />
                @if (blocked() && quote()) {<p class="text-sm font-medium text-vermilion">{{ blocked() }}</p>}
                <button pcButton variant="buy" size="lg" class="w-full" [loading]="placing()" [disabled]="!canPay()" (click)="place()" data-testid="checkout-pay">{{ payText() }}</button>
                <p class="flex items-center justify-center gap-1.5 text-center text-xs text-ink-faint"><svg [pcIcon]="Lock" class="h-3.5 w-3.5 shrink-0" /> Prices include GST. Each seller issues their own tax invoice.</p>
              </div>
            </div>
            @if (opts()?.cancellation_note) {<pc-cancellation-note [note]="opts()!.cancellation_note" />}
          </aside>

          <pc-payment-methods extraClass="lg:col-start-1 lg:row-start-2" [method]="method()" (methodChange)="method.set($event); error.set(null)"
            [onlineAvailable]="quote() ? quote()!.online_available : true" [codAvailable]="quote() ? quote()!.cod_available : true"
            [codAllowed]="quote()?.cod_allowed" [codMax]="quote()?.cod_max_order_paise ?? 0" [codFee]="quote()?.summary?.cod_fee ?? 0" [total]="quote()?.summary?.grand_total" />

          @if (showBar()) {
            <pc-pay-bar [method]="method()" [total]="quote() ? quote()!.summary.grand_total : null" (change)="scrollToPayment()" (confirm)="place()"
              [disabled]="!canPay()" [loading]="placing()" [notice]="blocked()" [error]="error()" />
          }
        </div>
      </div>
    }
  `,
})
export class ShopCheckoutPage {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  private readonly siteService = inject(SiteService);
  protected readonly site = this.siteService.site;
  private readonly lists = this.siteService.lists;
  private readonly regional = inject(RegionalService);

  protected readonly addresses = signal<Address[] | null>(null);
  protected readonly addressId = signal<string | null>(null);
  protected readonly adding = signal(false);
  protected readonly loadError = signal<string | null>(null);

  protected readonly method = signal<PayMethod>("online");
  protected readonly coupon = signal<string | null>(null);
  protected readonly couponError = signal<{ code: string; message: string } | null>(null);
  protected readonly offers = signal<OfferCoupon[]>([]);
  protected readonly tip = signal(0);

  protected readonly quote = signal<Quote | null>(null);
  private readonly settledKey = signal<string | null>(null);
  protected readonly quoteError = signal<string | null>(null);
  protected readonly related = signal<ProductCard[]>([]);

  // Instructions typed for each address; an address nobody typed for shows its saved instructions.
  private readonly notes = signal<Record<string, string | undefined>>({});
  protected readonly saveNote = signal(false);
  protected readonly gstin = signal("");
  protected readonly business = signal("");
  protected readonly bizOpen = signal(false);
  protected readonly bizChecked = signal(false);
  protected readonly bizServerError = signal<string | null>(null);
  protected readonly noBag = signal(false);
  protected readonly gift = signal("");

  protected readonly error = signal<string | null>(null);
  protected readonly placing = signal(false);
  protected readonly done = signal(false); // the order exists; the page is on its way out
  // One key per checkout visit: a double tap or a retry after a network error cannot create two orders.
  private readonly idempotencyKey = newIdempotencyKey();
  private readonly trackQuote = latestOnly();
  private readonly trackRelated = latestOnly();

  protected readonly CARD = CARD;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly MapPin = MapPin;
  protected readonly Lock = Lock;

  protected readonly opts = computed(() => this.quote()?.checkout);
  private readonly request = computed<QuoteBody | null>(() => {
    const id = this.addressId();
    return id ? { address_id: id, payment_method: this.method(), coupon_code: this.coupon(), tip_paise: this.tip() } : null;
  });
  private readonly currentKey = computed(() => {
    const r = this.request();
    return r ? quoteKey(r, this.session.cartCount()) : null;
  });
  protected readonly quoting = computed(() => !!this.currentKey() && !this.done() && this.currentKey() !== this.settledKey());

  private readonly selected = computed(() => this.addresses()?.find((a) => a.id === this.addressId()) ?? null);
  private readonly savedNote = computed(() => {
    const q = this.quote();
    return (q && q.address_id === this.addressId() && q.address ? q.address.instructions : this.selected()?.instructions) ?? "";
  });
  protected readonly noteText = computed(() => {
    const id = this.addressId();
    return (id ? this.notes()[id] : undefined) ?? this.savedNote();
  });

  private readonly biz = computed(() => businessErrors(this.gstin(), this.business()));
  private readonly bizFilled = computed(() => this.gstin().trim() !== "");
  private readonly bizValid = computed(() => this.bizFilled() && !this.biz().gstin && !this.biz().business);

  protected readonly blocked = computed<string | null>(() => {
    const q = this.quote();
    return !this.addressId()
      ? "Add a delivery address to continue."
      : !q
        ? null
        : q.summary.has_problems
          ? "Some items need your attention. Update your cart to continue."
          : q.summary.item_count === 0
            ? "Your cart is empty."
            : this.method() === "cod" && q.cod_allowed === false
              ? "Choose online payment for this order."
              : null;
  });
  protected readonly canPay = computed(() => !!this.quote() && !!this.addressId() && !this.quoting() && !this.blocked() && !this.done());
  protected readonly payText = computed(() => {
    const s = this.quote()?.summary;
    return this.method() === "online" ? (s ? `Pay ${rupees(s.grand_total)}` : "Pay") : "Place order";
  });
  protected readonly showBar = computed(() => !!this.quote() && this.quote()!.groups.length > 0);

  // "Did you forget?": products from the same categories as the cart (the API takes up to 20 ids).
  private readonly relatedIds = computed(() => {
    const q = this.quote();
    return q ? [...new Set(q.groups.flatMap((g) => g.lines.map((l) => l.product_id ?? "")).filter(Boolean))].slice(0, 20).join(",") : "";
  });

  constructor() {
    effect(() => {
      if (this.session.ready() && !this.session.user()) void this.router.navigateByUrl("/login?next=/checkout", { replaceUrl: true });
    });

    let loadedFor: string | null = null;
    effect(() => {
      const user = this.session.user();
      if (!user || loadedFor === user.id) return;
      loadedFor = user.id;
      untracked(() => this.loadAddresses().catch((e) => this.loadError.set(e instanceof ApiError ? e.message : "Could not load your addresses")));
    });

    // Adding a product from "Did you forget?" changes cartCount, so the bill is worked out again.
    effect(() => {
      const body = this.request();
      const count = this.session.cartCount();
      if (!body || this.done()) return;
      untracked(() => this.runQuote(body, quoteKey(body, count)));
    });

    effect(() => {
      const on = !!this.session.user() && this.site().features.coupons;
      if (on) untracked(() => api<{ items: OfferCoupon[] }>("/api/checkout/coupons").then((r) => this.offers.set(r.items)).catch(() => {}));
    });

    effect(() => {
      const ids = this.relatedIds();
      const limit = this.lists().checkout_suggestions;
      if (!ids || limit <= 0) return;
      untracked(() => this.trackRelated(api<{ items: ProductCard[] }>("/api/catalog/related", { query: { ids, limit } }), (r) => this.related.set(r.items)).catch(() => {}));
    });

    // Moves the help button above the pay bar and hides the compare tray on phones (see globals.css).
    effect((onCleanup) => {
      if (!this.showBar()) return;
      document.body.dataset["buyBar"] = "1";
      onCleanup(() => delete document.body.dataset["buyBar"]);
    });
    inject(DestroyRef).onDestroy(() => delete document.body.dataset["buyBar"]);
  }

  private loadAddresses(): Promise<void> {
    return api<Address[]>("/api/addresses").then((list) => {
      this.addresses.set(list);
      this.addressId.update((cur) => cur ?? list.find((a) => a.is_default)?.id ?? list[0]?.id ?? null);
      if (!list.length) this.adding.set(true);
    });
  }

  protected retryAddresses(): void {
    this.loadError.set(null);
    this.loadAddresses().catch((e) => this.loadError.set(e instanceof ApiError ? e.message : "Could not load your addresses"));
  }

  private runQuote(body: QuoteBody, key: string): Promise<QuoteResult> {
    return this.trackQuote(
      api<Quote>("/api/checkout/quote", { method: "POST", body }).then(
        (q): QuoteResult => ({ ok: true, quote: q }),
        (err: unknown): QuoteResult => ({ ok: false, error: err }),
      ),
      (r) => {
        this.settledKey.set(key);
        if (!r.ok) {
          this.quoteError.set(r.error instanceof ApiError ? r.error.message : "Could not work out your bill. Try again.");
          return;
        }
        const q = r.quote;
        this.quote.set(q);
        this.quoteError.set(null);
        if (body.payment_method === "online" && !q.online_available) this.method.set("cod");
        if (q.coupon?.error) {
          // Keep the reason on screen and stop sending the code.
          this.couponError.set({ code: q.coupon.code, message: q.coupon.error });
          this.coupon.set(null);
        }
      },
    );
  }

  protected retryQuote(): void {
    const r = this.request();
    const k = this.currentKey();
    if (r && k) void this.runQuote(r, k);
  }

  protected async onSaved(a: Address): Promise<void> {
    this.adding.set(false);
    await this.loadAddresses();
    this.addressId.set(a.id);
  }

  protected setNote(t: string): void {
    const id = this.addressId();
    if (id) this.notes.update((n) => ({ ...n, [id]: t }));
  }

  protected billOf(q: Quote) {
    return { ...q.summary, coupon_code: q.coupon && !q.coupon.error ? q.coupon.code : null, coupon_discount: q.summary.coupon_discount ?? 0 };
  }

  protected scrollToPayment(): void {
    scrollToSection("checkout-payment", 'input[name="pay"]:checked');
  }

  protected async place(): Promise<void> {
    const addressId = this.addressId();
    const quote = this.quote();
    const opts = this.opts();
    if (!addressId || !quote || !this.canPay() || this.placing()) return;
    if (opts?.gstin_enabled && this.bizFilled() && !this.bizValid()) {
      this.bizOpen.set(true);
      this.bizChecked.set(true);
      this.error.set("Check the GSTIN details, or remove them to continue.");
      requestAnimationFrame(() => scrollToSection("checkout-business", "input[aria-invalid='true']"));
      return;
    }
    this.placing.set(true);
    this.error.set(null);
    const instructions = opts?.instructions_enabled ? this.noteText().trim() : "";
    const request = this.request();
    const currentKey = this.currentKey();
    try {
      if (opts?.instructions_enabled && this.saveNote() && instructions !== this.savedNote().trim()) {
        await api(`/api/addresses/${addressId}/instructions`, { method: "PATCH", body: { instructions } }).catch(() =>
          this.toast.show("Could not save the instructions for next time. They are still sent with this order.", "error"),
        );
      }
      const withBiz = !!opts?.gstin_enabled && this.bizValid();
      const currency = this.regional.currency();
      const r = await api<{ order: OrderDetail; payment: CheckoutPayload | null }>("/api/orders", {
        method: "POST",
        body: {
          address_id: addressId,
          payment_method: this.method(),
          idempotency_key: this.idempotencyKey,
          expected_total: quote.summary.grand_total,
          coupon_code: quote.coupon && !quote.coupon.error ? quote.coupon.code : null,
          tip_paise: quote.summary.tip ?? 0,
          buyer_gstin: withBiz ? this.gstin().trim() : "",
          buyer_business: withBiz ? this.business().trim() : "",
          instructions,
          no_bag: !!opts?.no_bag_enabled && this.noBag(),
          gift_message: opts?.gift_message_enabled ? this.gift().trim() : "",
          currency: currency !== "INR" ? currency : undefined, // Admin → Languages and currencies: may be charged in it
        },
      });
      this.done.set(true);
      await this.session.refreshCart();
      if (r.payment) {
        // The order page opens the payment window. If a phone reloads the page while the shopper is in a UPI app, they
        // come back to their order (not an empty checkout), which asks Razorpay whether the payment arrived.
        void this.router.navigateByUrl(`/orders/${r.order.id}?pay=1`, { replaceUrl: true });
      } else {
        void this.router.navigateByUrl(`/orders/${r.order.id}?placed=1`, { replaceUrl: true });
      }
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not place the order");
      if (e instanceof ApiError) {
        if ((e.code === "total_changed" || e.code === "cart_changed") && request && currentKey) {
          void this.runQuote(request, currentKey);
        } else if (e.code === "invalid_gstin") {
          this.bizOpen.set(true);
          this.bizServerError.set(e.message);
        } else if (e.code === "invalid_tip") {
          this.tip.set(0);
        }
      }
      this.placing.set(false);
    }
  }
}
