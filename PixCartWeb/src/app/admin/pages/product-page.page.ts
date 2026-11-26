/*
 * Admin → Product page: every block of the product page can be switched on or off here, with the few numbers that
 * tune them. Legal information (seller identity, grievance officer, country of origin, Legal Metrology declarations)
 * is always shown and has no switch. Port of frontend/src/app/admin/product-page/page.tsx.
 */

import { ChangeDetectionStrategy, Component, inject, input, output, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Select, TextField, Toast } from "../../shared/ui/ui";

type S = Record<string, boolean | number>;

const GROUPS: { title: string; sub: string; items: [string, string, string][] }[] = [
  {
    title: "Price and buying",
    sub: "Beside the price and in the buy box.",
    items: [
      ["pdp_unit_price", "Unit price", "₹ per 100 g, kg, litre or piece next to the price, from the net quantity sellers enter."],
      ["pdp_offers", "Offers on the product page", "Coupons this product qualifies for (store-wide, its category or the seller's own), with a copy-code button."],
      ["pdp_service_icons", "Service icons", "Free delivery, pay on delivery, returns, top seller, verified seller, GST invoice and secure payment."],
      ["pdp_delivery_countdown", "Order-within countdown", "\"Order within 2 hrs 10 mins\" when the seller has set a daily dispatch cut-off time."],
      ["pdp_sticky_bar", "Buy bar on phones", "Price, Add to cart and Buy now stay at the bottom of the screen while the shopper scrolls."],
      ["header_pincode", "Delivery PIN in the header", "\"Deliver to 641001\" on every page; delivery dates and charges follow it. Signed-in shoppers start from their default address."],
    ],
  },
  {
    title: "Trust and social proof",
    sub: "Only real figures are shown; weak numbers are left out.",
    items: [
      ["pdp_bought_count", "Bought in the past month", "\"300+ bought in the past month\" from units sold in the last 30 days."],
      ["pdp_bestseller_badge", "Best seller badge and rank", "\"#1 Best seller in <category>\" for the top 10 in a category, and the rank in Item details."],
      ["pdp_seller_snapshot", "Seller snapshot", "Positive ratings, orders in 3 months, on-time dispatch and time on the store, with a Top seller badge."],
      ["pdp_customer_media", "Customer photos under the gallery", "Thumbnails of photos and videos from reviews, opening a viewer with the review beside each one."],
    ],
  },
  {
    title: "Information and help",
    sub: "",
    items: [
      ["pdp_key_specs", "Key specifications beside the price", "Up to 6 specifications the seller marks as key (otherwise the first few), plus the net quantity."],
      ["pdp_ask_assistant", "Ask a question", "Opens the shop assistant with the product named, so shoppers get answers without leaving the page."],
      ["pdp_share", "Share", "WhatsApp, Facebook, X, email and copy link; the phone's own share sheet on mobiles."],
      ["pdp_report", "Report an issue with this product", "Signed-in shoppers report wrong information, fakes, unsafe or banned items. Reports go to Product reports."],
    ],
  },
  {
    title: "Questions and answers",
    sub: "Shoppers ask on the product page; the seller and other shoppers answer. Posts with phone numbers, emails or links always wait for a check in Questions.",
    items: [
      ["feature_qa", "Questions and answers", "A Q&A section on every product page. Only signed-in shoppers can ask, answer or vote; guests can read."],
      ["qa_need_approval", "Check every post first", "Questions and answers wait in Admin → Questions before they appear."],
      ["qa_buyers_answer_only", "Only the seller and buyers answer", "Shoppers who have not received the product cannot answer questions."],
    ],
  },
  {
    title: "Alerts",
    sub: "Sent by email, SMS or push, following each shopper's notification choices.",
    items: [
      ["feature_stock_alerts", "Notify me when it is back", "Out-of-stock versions show a Notify me button; signed-in shoppers get a message when stock returns."],
      ["feature_price_alerts", "Wishlist price drops", "Shoppers get a message when a product in their wishlist gets cheaper."],
    ],
  },
  {
    title: "Compare and bundles",
    sub: "",
    items: [
      ["feature_compare", "Compare products", "\"Add to compare\" on product cards and product pages, a compare tray, and up to 4 products side by side."],
      ["feature_bought_together", "Frequently bought together", "Products often ordered together, worked out from real orders, with one click to add them all."],
    ],
  },
  {
    title: "More products",
    sub: "",
    items: [
      ["pdp_similar", "Customers also viewed", "Popular products from the same category."],
      ["pdp_recently_viewed", "Browsing history", "Products this shopper opened recently (kept in their browser only)."],
      ["page_loading_bar", "Page loading bar", "A thin bar at the top of the window while the next page loads, across the store, seller hub and admin."],
    ],
  },
];

/** A switch with its label and hint (the reference's local Toggle). */
@Component({
  selector: "pc-pdp-toggle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label class="flex items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="checked()" (change)="toggle.emit($any($event.target).checked)" [attr.data-testid]="'toggle-' + k()" />
      <span><span class="font-semibold">{{ label() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
    </label>
  `,
})
export class PdpToggle {
  readonly k = input.required<string>();
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly toggle = output<boolean>();
}

@Component({
  selector: "pc-admin-product-page-page",
  imports: [PageHeader, PcLink, PageLoader, Button, ErrorNote, Select, TextField, PdpToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!s()) {
      <pc-page-loader />
    } @else {
      <form (submit)="save($event)" class="flex max-w-4xl flex-col gap-4">
        <pc-page-header title="Product page" sub="Choose what shoppers see on every product page. Changes show at once." />
        <pc-error-note [message]="error()" />

        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Photos and videos</h2>
          <pc-pdp-toggle k="gallery_zoom" label="Zoom on hover" hint="On a computer, moving the mouse over a photo shows a magnified view beside it. Clicking always opens the full-screen viewer." [checked]="b('gallery_zoom')" (toggle)="set('gallery_zoom', $event)" />
          <label class="flex flex-col gap-1 rounded-lg border border-line p-3">
            <span class="font-semibold">Zoom strength</span>
            <select pcSelect (change)="set('gallery_zoom_level', +$any($event.target).value)" [disabled]="!b('gallery_zoom')" aria-label="Zoom strength">
              @for (z of zoomLevels; track z[0]) {<option [value]="z[0]" [selected]="n('gallery_zoom_level') === z[0]">{{ z[1] }}</option>}
            </select>
            <span class="text-xs text-ink-faint">Upload photos at least 1000 px wide so the zoom stays sharp.</span>
          </label>
          <pc-pdp-toggle k="feature_product_videos" label="Product videos" hint="Sellers can add MP4 or WebM videos; customers play them from the gallery. Off hides existing videos too." [checked]="b('feature_product_videos')" (toggle)="set('feature_product_videos', $event)" />
          <div class="grid grid-cols-2 gap-3">
            <pc-text-field label="Largest video (MB)" [value]="str('max_video_mb')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('max_video_mb', $event)" hint="5 to 200" [disabled]="!b('feature_product_videos')" />
            <pc-text-field label="Videos per listing" [value]="str('max_videos_per_listing')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('max_videos_per_listing', $event)" hint="0 to 10" [disabled]="!b('feature_product_videos')" />
          </div>
        </section>

        @for (g of groups; track g.title) {
          <section [attr.id]="g.title === 'Questions and answers' ? 'qa' : null" class="grid scroll-mt-24 gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <h2 class="text-lg font-semibold">{{ g.title }}</h2>
              @if (g.sub) {<p class="text-sm text-ink-soft">{{ g.sub }}</p>}
            </div>
            @for (it of g.items; track it[0]) {<pc-pdp-toggle [k]="it[0]" [label]="it[1]" [hint]="it[2]" [checked]="b(it[0])" (toggle)="set(it[0], $event)" />}
            @if (g.title === "Questions and answers") {
              <pc-text-field label="Hide a post after this many reports" [value]="str('qa_report_hide_at')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('qa_report_hide_at', $event)" [disabled]="!b('feature_qa')"
                hint="Each shopper counts once. The post waits in Questions until staff check it. 0 = never hide automatically; up to 50." />
            }
            @if (g.title === "Alerts") {
              <pc-text-field label="Price drop: at least (%)" [value]="str('price_alert_min_drop_pct')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('price_alert_min_drop_pct', $event)" hint="Smaller drops are not sent. 1 to 90." [disabled]="!b('feature_price_alerts')" />
            }
            @if (g.title === "Price and buying") {
              <pc-text-field label="Offers shown at most" [value]="str('pdp_offers_max')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('pdp_offers_max', $event)" hint="1 to 10" [disabled]="!b('pdp_offers')" />
            }
            @if (g.title === "Trust and social proof") {
              <div class="grid gap-3 sm:col-span-2 sm:grid-cols-3">
                <pc-text-field label="'Bought' line from (units in 30 days)" [value]="str('pdp_bought_min')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('pdp_bought_min', $event)" hint="Below this, the line is not shown" [disabled]="!b('pdp_bought_count')" />
                <pc-text-field label="Top seller: rating at least (×10)" [value]="str('top_seller_min_rating_x10')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('top_seller_min_rating_x10', $event)" hint="40 = 4.0 stars (30 to 50)" [disabled]="!b('pdp_seller_snapshot')" />
                <pc-text-field label="Top seller: orders in 90 days" [value]="str('top_seller_min_orders')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('top_seller_min_orders', $event)" hint="And at least 5 ratings" [disabled]="!b('pdp_seller_snapshot')" />
              </div>
            }
          </section>
        }

        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <div class="sm:col-span-2">
            <h2 class="text-lg font-semibold">Discovery pages</h2>
            <p class="text-sm text-ink-soft">Bestsellers and Hot new releases rank products by units sold in the last 30 days.</p>
          </div>
          <pc-text-field label="Hot new releases: products launched in the last N days" [value]="str('new_release_days')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('new_release_days', $event)" hint="7 to 180 days, counted from when the listing went live" />
        </section>

        <section class="rounded-xl bg-white p-5 text-sm text-ink-soft">
          <h2 class="mb-1 text-lg font-semibold text-ink">Related settings</h2>
          <ul class="list-disc space-y-1 pl-5">
            <li><a pcLink="/admin/reviews" class="font-semibold text-peacock">Reviews → Settings</a>: who can review, customer photos and videos, moderation, topics and guidelines.</li>
            <li><a pcLink="/admin/categories" class="font-semibold text-peacock">Categories</a>: the product information (net quantity, manufacturer, FSSAI licence and more) each category requires before a listing can be submitted.</li>
            <li><a pcLink="/admin/coupons" class="font-semibold text-peacock">Coupons</a>: coupons marked “show in the offers list” appear on product pages.</li>
            <li><a pcLink="/admin/deals" class="font-semibold text-peacock">Deals → Rules</a> and <a pcLink="/admin/advertising" class="font-semibold text-peacock">Advertising → Settings</a>: deal badges, countdowns and Sponsored rows on product pages.</li>
            <li><a pcLink="/admin/questions" class="font-semibold text-peacock">Questions</a>: check, publish or hide questions and answers.</li>
            <li><a pcLink="/admin/settings" class="font-semibold text-peacock">Marketplace settings</a>: delivery fee, free-delivery amount, cash on delivery and transit days used in delivery dates.</li>
            <li>Seller identity, GSTIN, grievance officer and country of origin are always shown, as the Consumer Protection (E-Commerce) Rules require.</li>
          </ul>
        </section>
        <button pcButton type="submit" [loading]="busy()" class="self-start">Save product page settings</button>
      </form>
    }
  `,
})
export class AdminProductPagePage {
  private readonly toast = inject(Toast);
  protected readonly groups = GROUPS;
  protected readonly zoomLevels: [number, string][] = [[15, "1.5×"], [20, "2×"], [25, "2.5× (recommended)"], [30, "3×"], [40, "4×"]];
  /** what a numeric field shows after typing, like the reference's Number(digits) || 0 */
  protected readonly digits = (x: string) => String(Number(x.replace(/\D/g, "")) || 0);
  protected readonly s = signal<S | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    api<S>("/api/admin/settings").then((x) => this.s.set(x)).catch(quietly);
  }

  protected b(k: string): boolean {
    return Boolean(this.s()?.[k]);
  }

  protected n(k: string): number {
    return Number(this.s()?.[k]);
  }

  protected str(k: string): string {
    return String(this.s()?.[k] ?? "");
  }

  protected set(k: string, v: boolean | number): void {
    this.s.update((s) => (s ? { ...s, [k]: v } : s));
  }

  protected setNum(k: string, x: string): void {
    this.set(k, Number(x.replace(/\D/g, "")) || 0);
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const s = this.s();
    if (!s) return;
    const newDays = Number(s["new_release_days"]);
    if (!Number.isInteger(newDays) || newDays < 7 || newDays > 180) {
      this.error.set("Hot new releases: enter 7 to 180 days");
      return;
    }
    const drop = Number(s["price_alert_min_drop_pct"]);
    if (!Number.isInteger(drop) || drop < 1 || drop > 90) {
      this.error.set("Price drop alerts: enter 1 to 90 percent");
      return;
    }
    if (Number(s["qa_report_hide_at"]) > 50) {
      this.error.set("Questions and answers: enter 0 to 50 reports");
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    const keys = [...GROUPS.flatMap((g) => g.items.map(([k]) => k)), "pdp_bought_min", "pdp_offers_max", "top_seller_min_rating_x10", "top_seller_min_orders",
      "gallery_zoom", "gallery_zoom_level", "feature_product_videos", "max_video_mb", "max_videos_per_listing", "new_release_days", "price_alert_min_drop_pct",
      "qa_report_hide_at"];
    try {
      this.s.set(await api<S>("/api/admin/settings", { method: "PUT", body: Object.fromEntries(keys.map((k) => [k, s[k]])) }));
      this.toast.show("Product page settings saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
