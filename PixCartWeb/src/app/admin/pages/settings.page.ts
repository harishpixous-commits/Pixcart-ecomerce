/* Admin → Marketplace settings: maintenance mode, delivery, COD, taxes, features, delivery estimates, orders and payouts,
 * returns, lists, error pages, mobile apps and the admin layout. Port of frontend/src/app/admin/settings/page.tsx. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { paiseToInput, toPaise, WEEKDAYS } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Select, TextField, Toast } from "../../shared/ui/ui";
import { MobileApps, type AppSettings } from "../settings/mobile-apps";

type S = Record<string, unknown> & {
  shipping_fee_paise: number; free_shipping_threshold_paise: number; cod_enabled: boolean; cod_fee_paise: number; cod_max_order_paise: number; tcs_bps: number; tds_bps: number; commission_gst_bps: number; max_qty_per_item: number; shipping_per_kg_paise?: number; shipping_free_grams?: number;
  transit_days_same_city: number; transit_days_same_state: number; transit_days_national: number;
  auto_cancel_unconfirmed_hours: number; payout_min_paise: number; low_stock_threshold: number;
  payout_weekday: number; payout_every_weeks: number; defect_return_days: number; admin_layout_default: string;
  maintenance_mode: boolean; maintenance_message: string;
  shop_app_banner: boolean; shop_android_apk_url: string; shop_play_store_url: string; shop_app_store_url: string; shop_app_version: string; payment_window_minutes: number;
  customer_cancel_until: "placed" | "confirmed" | "packed"; payment_return_mode: "return" | "window";
};

/** Error pages: [setting, label, longest]. */
const PAGE_TEXTS: [string, string, number][] = [
  ["not_found_title", "\"Page not found\" title", 80],
  ["not_found_message", "\"Page not found\" message", 300],
  ["error_title", "\"Something went wrong\" title", 80],
  ["error_message", "\"Something went wrong\" message", 300],
];
const PAGE_SWITCHES: [string, string, string][] = [
  ["not_found_search", "Search box on the \"Page not found\" page", "Shoppers can search straight away"],
  ["not_found_suggestions", "Bestsellers on the \"Page not found\" page", "A row of popular products under the message"],
];

/** How many results each list shows: [setting, label, hint, the default]. 0 hides the lists whose hint says so. */
const LIST_FIELDS: [string, string, string, number][] = [
  ["search_page_size", "Products per search or category page", "From 8 to 60", 24],
  ["search_suggestions", "Search suggestions while typing", "From 1 to 12", 8],
  ["recent_searches_max", "Recent searches remembered", "0 turns recent searches off", 8],
  ["brand_filter_max", "Brands listed in the filters", "From 5 to 100", 30],
  ["similar_products", "\"Customers also viewed\" on a product page", "0 hides the row", 12],
  ["sponsored_on_product", "Sponsored products on a product page", "0 hides the row", 10],
  ["highlights_shown", "Bullet points shown before \"See more\"", "From 1 to 20", 5],
  ["customer_photos_shown", "Customer photos shown on a product page", "0 hides the strip", 6],
  ["reviews_page_size", "Reviews per page", "From 5 to 50", 10],
  ["questions_page_size", "Questions per page", "From 5 to 50", 10],
  ["bestseller_badge_top", "Show the \"#N Best seller\" badge for the top", "From 1 to 100", 10],
  ["recently_viewed_max", "Recently viewed products remembered", "From 4 to 30", 12],
  ["compare_max", "Products compared at once", "From 2 to 6", 4],
  ["checkout_suggestions", "Suggestions at checkout", "0 hides them", 10],
];

const ADMIN_LAYOUT_NAMES: [string, string][] = [["sidebar", "Sidebar"], ["topnav", "Top navigation"], ["rail", "Compact rail"], ["glass", "Glass"]];

const FLAGS: [string, string, string][] = [
  ["feature_wishlist", "Wishlist", "Customers can save products for later"],
  ["feature_reviews", "Ratings and reviews", "Customers can rate and review products (more options in Reviews → Settings)"],
  ["feature_returns", "Returns", "Customers can request returns inside the return window"],
  ["auto_approve_returns", "Approve returns automatically", "Skip the seller's approval step; the seller still confirms receipt"],
  ["feature_coupons", "Coupons", "Coupon box and offers list at checkout"],
  ["feature_support", "Help centre", "Customers can raise support tickets"],
  ["auto_payouts", "Automatic payouts", "Create payouts on the payout day (Orders and payouts) for balances above the minimum"],
];

const AREA = "w-full rounded-lg border border-line bg-white px-3 py-2 text-[15px] focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20";

@Component({
  selector: "pc-admin-settings-page",
  imports: [PageHeader, PcLink, PageLoader, Button, ErrorNote, Field, Select, TextField, MobileApps],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!s()) {
      <pc-page-loader />
    } @else {
      <form (submit)="save($event)" class="flex max-w-3xl flex-col gap-4">
        <pc-page-header title="Marketplace settings" />
        <pc-error-note [message]="error()" />
        <section id="maintenance" [class]="'grid scroll-mt-24 gap-3 rounded-xl p-5 ' + (s()!.maintenance_mode ? 'bg-marigold-light ring-2 ring-marigold' : 'bg-white')" data-testid="maintenance-settings">
          <div>
            <h2 class="text-lg font-semibold">Maintenance mode {{ "" }}@if (s()!.maintenance_mode) {<span class="ml-1 rounded-full bg-marigold px-2 align-middle text-xs font-bold">On now</span>}</h2>
            <p class="text-sm text-ink-soft">
              Close the shop for a while, for example during a big catalogue update. Shoppers see your message instead of the shop and
              cannot place orders; their carts are kept. Staff still see the shop with a reminder bar. Sellers, delivery partners and
              the admin panel keep working.
            </p>
          </div>
          <label class="flex items-start gap-3 rounded-lg border border-line bg-white p-3">
            <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="maintenance()" (change)="maintenance.set($any($event.target).checked)" data-testid="maintenance-toggle" />
            <span><span class="font-semibold">Close the shop for maintenance</span><br /><span class="text-sm text-ink-soft">Takes effect when you save</span></span>
          </label>
          <pc-field label="Message shoppers see" for="maintenance-message" [hint]="'10 to 300 characters · ' + v('maintenanceMessage').length + '/300'">
            <textarea id="maintenance-message" rows="2" maxlength="300" [value]="v('maintenanceMessage')" (input)="setF('maintenanceMessage', $any($event.target).value)" [class]="area"></textarea>
          </pc-field>
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Delivery</h2>
          <p class="text-sm text-ink-soft sm:col-span-2">
            Delivery, cash on delivery and all other fees on the customer's bill can also be set in{{ " " }}<a pcLink="/admin/checkout" class="font-semibold text-peacock">Checkout and fees</a>, with a live preview.
          </p>
          <pc-text-field label="Delivery fee per seller package (₹)" [value]="v('shipping')" (valueChange)="setF('shipping', $event)" />
          <pc-text-field label="Free delivery from (₹, per seller)" [value]="v('free')" (valueChange)="setF('free', $event)" />
          <pc-text-field label="Maximum quantity per item" [value]="v('qty')" (valueChange)="setF('qty', $event)" hint="1 to 10 units of one item in an order" />
          <pc-text-field label="Extra delivery fee per kg (₹)" [value]="v('perKg')" (valueChange)="setF('perKg', $event)" hint="Added for each started kg above the free weight, per seller package. 0 switches it off. Packages that already ship free stay free." />
          <pc-text-field label="Weight covered by the delivery fee (grams)" [value]="v('freeGrams')" (valueChange)="setF('freeGrams', $event)" hint="0 to 50000. Used only when the extra fee per kg is above 0." />
          <pc-text-field label="Low stock at (units)" [value]="v('lowStock')" (valueChange)="setF('lowStock', $event)" inputmode="numeric"
            hint="Shoppers see “Only N left”, and sellers get a low-stock alert, at or below this many units" />
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Cash on delivery</h2>
          <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="accent-peacock" [checked]="cod()" (change)="cod.set($any($event.target).checked)" /> Offer cash on delivery</label>
          <pc-text-field label="COD fee (₹)" [value]="v('codFee')" (valueChange)="setF('codFee', $event)" />
          <pc-text-field label="COD available up to (₹ order value)" [value]="v('codMax')" (valueChange)="setF('codMax', $event)" />
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
          <h2 class="text-lg font-semibold sm:col-span-3">Taxes deducted from seller payouts</h2>
          <pc-text-field label="GST TCS (%)" [value]="v('tcs')" (valueChange)="setF('tcs', $event)" hint="Section 52 CGST Act: 0.5% since 10 July 2024" />
          <pc-text-field label="Income-tax TDS (%)" [value]="v('tds')" (valueChange)="setF('tds', $event)" hint="E-commerce TDS: 0.1% since 1 October 2024" />
          <pc-text-field label="GST on commission (%)" [value]="v('cgst')" (valueChange)="setF('cgst', $event)" hint="Usually 18%" />
          <p class="text-sm text-ink-soft sm:col-span-3">Changes apply to new orders only. Confirm rates with your chartered accountant.</p>
        </section>
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-3 text-lg font-semibold">Features</h2>
          <div class="grid gap-3 sm:grid-cols-2">
            @for (x of flagList; track x[0]) {
              <label class="flex items-start gap-3 rounded-lg border border-line p-3">
                <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="flags()[x[0]] ?? false" (change)="setFlag(x[0], $any($event.target).checked)" />
                <span><span class="font-semibold">{{ x[1] }}</span><br /><span class="text-sm text-ink-soft">{{ x[2] }}</span></span>
              </label>
            }
          </div>
        </section>
        <section class="rounded-xl bg-white p-5 text-sm text-ink-soft">
          <h2 class="mb-1 text-lg font-semibold text-ink">Product page</h2>
          Photo zoom, product videos, unit price, offers, seller snapshot and every other product page block are in{{ " " }}<a pcLink="/admin/product-page" class="font-semibold text-peacock">Product page</a>; review options in{{ " " }}<a pcLink="/admin/reviews" class="font-semibold text-peacock">Reviews → Settings</a>.
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
          <h2 class="text-lg font-semibold sm:col-span-3">Delivery estimates</h2>
          <p class="text-sm text-ink-soft sm:col-span-3">Days in transit, added to each seller's dispatch days to show the expected delivery date.</p>
          <pc-text-field label="Same city" [value]="v('city')" (valueChange)="setF('city', $event)" />
          <pc-text-field label="Same state" [value]="v('state')" (valueChange)="setF('state', $event)" />
          <pc-text-field label="Rest of India" [value]="v('national')" (valueChange)="setF('national', $event)" />
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Orders and payouts</h2>
          <pc-text-field label="Cancel orders sellers don't confirm within (hours)" [value]="v('autoCancel')" (valueChange)="setF('autoCancel', $event)" hint="0 turns this off. Customers are refunded in full." />
          <pc-text-field label="Time to pay online (minutes)" inputmode="numeric" [value]="v('payWindow')" (valueChange)="setF('payWindow', $event)" hint="Unpaid online orders are cancelled after this and the stock is released. 10 to 120." />
          <pc-field label="Customers can cancel by themselves" for="cancelUntil" hint="After this step they ask support, or return the item after delivery">
            <select pcSelect id="cancelUntil" (change)="setF('cancelUntil', $any($event.target).value)">
              <option value="placed" [selected]="v('cancelUntil') === 'placed'">Until the seller confirms</option>
              <option value="confirmed" [selected]="v('cancelUntil') === 'confirmed'">Until the seller packs</option>
              <option value="packed" [selected]="v('cancelUntil') === 'packed'">Until it is shipped</option>
            </select>
          </pc-field>
          <pc-field label="After paying in a UPI app (phones and the app)" for="payReturn"
            hint="How shoppers come back from Google Pay, PhonePe or another UPI app. Either way the order page asks Razorpay and shows paid, failed or Try again.">
            <select pcSelect id="payReturn" (change)="setF('payReturn', $any($event.target).value)">
              <option value="return" [selected]="v('payReturn') === 'return'">Razorpay sends them back to their order (recommended)</option>
              <option value="window" [selected]="v('payReturn') === 'window'">The payment window reports back on the same page</option>
            </select>
          </pc-field>
          <pc-text-field label="Minimum payout (₹)" [value]="v('payoutMin')" (valueChange)="setF('payoutMin', $event)" hint="Smaller balances wait for the next run" />
          <pc-field label="Payout day" for="payDay" hint="Automatic payouts start at 10:00 IST on this day">
            <select pcSelect id="payDay" (change)="setF('payDay', $any($event.target).value)">
              @for (name of weekdays; track name; let i = $index) {<option [value]="i" [selected]="'' + i === v('payDay')">{{ name }}</option>}
            </select>
          </pc-field>
          <pc-field label="How often" for="payEvery" hint="Sellers see the next payout date on their Payouts page">
            <select pcSelect id="payEvery" (change)="setF('payEvery', $any($event.target).value)">
              <option value="1" [selected]="v('payEvery') === '1'">Every week</option>
              <option value="2" [selected]="v('payEvery') === '2'">Every two weeks</option>
            </select>
          </pc-field>
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Returns</h2>
          <pc-text-field label="Take back damaged, faulty or wrong items for (days)" inputmode="numeric" [value]="v('defectDays')" (valueChange)="setF('defectDays', $event)"
            hint="Counted from delivery, also when a listing is not returnable. Sellers are paid after this period. 0 turns this off." />
          <p class="text-sm text-ink-soft">
            Each category's return window, and the shortest window sellers may choose, are set in{{ " " }}<a pcLink="/admin/categories" class="font-semibold text-peacock">Categories</a>.
          </p>
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" data-testid="list-settings">
          <div class="sm:col-span-2">
            <h2 class="text-lg font-semibold">Lists and results</h2>
            <p class="text-sm text-ink-soft">How many results each list shows to shoppers. The default is shown with each one.</p>
          </div>
          @for (l of listFields; track l[0]) {
            <pc-text-field [label]="l[1]" inputmode="numeric" [hint]="l[2] + '. Default ' + l[3] + '.'" [value]="v(l[0])" (valueChange)="setF(l[0], $event)" />
          }
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5" data-testid="search-synonyms">
          <div>
            <h2 class="text-lg font-semibold">Search synonyms</h2>
            <p class="text-sm text-ink-soft">Words that mean the same to a shopper. A search for one also finds products that use the others. Write each group on its own line or split with semicolons, for example: tee = t-shirt = tshirt</p>
          </div>
          <pc-field label="Synonym groups" for="search-synonyms" [hint]="'Single words only. Leave empty to turn off. ' + v('search_synonyms').length + '/1000'">
            <textarea id="search-synonyms" rows="4" maxlength="1000" [value]="v('search_synonyms')" (input)="setF('search_synonyms', $any($event.target).value)" [class]="area"></textarea>
          </pc-field>
        </section>
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" data-testid="error-page-settings">
          <div class="sm:col-span-2">
            <h2 class="text-lg font-semibold">Error pages</h2>
            <p class="text-sm text-ink-soft">
              What shoppers see when a link is broken or a page fails to load. They show in the shop's theme, with its header and footer.
              Try them: <a href="/this-page-does-not-exist" target="_blank" rel="noreferrer" class="font-semibold text-peacock">open a missing page</a>.
            </p>
          </div>
          @for (p of pageTexts; track p[0]) {
            <pc-field [label]="p[1]" [for]="'pg-' + p[0]" [hint]="v(p[0]).length + '/' + p[2]">
              <textarea [id]="'pg-' + p[0]" [rows]="p[2] > 100 ? 3 : 1" [maxLength]="p[2]" [value]="v(p[0])" (input)="setF(p[0], $any($event.target).value)" [class]="area"></textarea>
            </pc-field>
          }
          @for (p of pageSwitches; track p[0]) {
            <label class="flex items-start gap-3 rounded-lg border border-line p-3">
              <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="pageFlags()[p[0]] ?? true" (change)="setPageFlag(p[0], $any($event.target).checked)" />
              <span><span class="font-semibold">{{ p[1] }}</span><br /><span class="text-sm text-ink-soft">{{ p[2] }}</span></span>
            </label>
          }
        </section>
        <pc-mobile-apps [value]="apps()" (valueChange)="apps.set($event)" />
        <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 class="text-lg font-semibold sm:col-span-2">Admin panel</h2>
          <pc-field label="Default layout for staff" for="admin-layout" hint="Staff who have not chosen their own layout (My account → Appearance) see this one.">
            <select pcSelect id="admin-layout" (change)="setF('adminLayout', $any($event.target).value)">
              @for (l of layouts; track l[0]) {<option [value]="l[0]" [selected]="l[0] === (f()['adminLayout'] ?? 'sidebar')">{{ l[1] }}</option>}
            </select>
          </pc-field>
        </section>
        <button pcButton type="submit" [loading]="busy()" class="self-start">Save settings</button>
      </form>
    }
  `,
})
export class AdminSettingsPage {
  private readonly toast = inject(Toast);
  protected readonly area = AREA;
  protected readonly weekdays = WEEKDAYS;
  protected readonly flagList = FLAGS;
  protected readonly listFields = LIST_FIELDS;
  protected readonly pageTexts = PAGE_TEXTS;
  protected readonly pageSwitches = PAGE_SWITCHES;
  protected readonly layouts = ADMIN_LAYOUT_NAMES;
  protected readonly s = signal<S | null>(null);
  protected readonly f = signal<Record<string, string>>({});
  protected readonly cod = signal(true);
  protected readonly maintenance = signal(false);
  protected readonly pageFlags = signal<Record<string, boolean>>({});
  protected readonly apps = signal<AppSettings>({ shop_app_banner: true, shop_android_apk_url: "", shop_play_store_url: "", shop_app_store_url: "", shop_app_version: "" });
  protected readonly flags = signal<Record<string, boolean>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    api<S>("/api/admin/settings").then((x) => {
      this.cod.set(x.cod_enabled);
      this.maintenance.set(Boolean(x.maintenance_mode));
      this.apps.set({ shop_app_banner: x.shop_app_banner !== false, shop_android_apk_url: x.shop_android_apk_url ?? "", shop_play_store_url: x.shop_play_store_url ?? "",
        shop_app_store_url: x.shop_app_store_url ?? "", shop_app_version: x.shop_app_version ?? "" });
      this.pageFlags.set(Object.fromEntries(PAGE_SWITCHES.map(([k]) => [k, x[k] !== false])));
      this.flags.set(Object.fromEntries(FLAGS.map(([k]) => [k, Boolean(x[k])])));
      this.f.set({
        shipping: paiseToInput(x.shipping_fee_paise), free: paiseToInput(x.free_shipping_threshold_paise), codFee: paiseToInput(x.cod_fee_paise),
        codMax: paiseToInput(x.cod_max_order_paise), tcs: String(x.tcs_bps / 100), tds: String(x.tds_bps / 100), cgst: String(x.commission_gst_bps / 100), qty: String(x.max_qty_per_item), perKg: paiseToInput(x.shipping_per_kg_paise ?? 0), freeGrams: String(x.shipping_free_grams ?? 1000),
        city: String(x.transit_days_same_city), state: String(x.transit_days_same_state), national: String(x.transit_days_national),
        autoCancel: String(x.auto_cancel_unconfirmed_hours), payoutMin: paiseToInput(x.payout_min_paise), lowStock: String(x.low_stock_threshold),
        defectDays: String(x.defect_return_days), payDay: String(x.payout_weekday), payEvery: String(x.payout_every_weeks),
        payWindow: String(x.payment_window_minutes ?? 30), cancelUntil: x.customer_cancel_until ?? "packed", payReturn: x.payment_return_mode ?? "return",
        adminLayout: x.admin_layout_default ?? "sidebar", maintenanceMessage: x.maintenance_message ?? "",
        ...Object.fromEntries(PAGE_TEXTS.map(([k]) => [k, String(x[k] ?? "")])), search_synonyms: String(x["search_synonyms"] ?? ""),
        ...Object.fromEntries(LIST_FIELDS.map(([k, , , d]) => [k, String(x[k] ?? d)])),
      });
      this.s.set(x);
    }).catch(quietly);
  }

  protected v(k: string): string {
    return this.f()[k] ?? "";
  }

  protected setF(k: string, v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected setFlag(k: string, on: boolean): void {
    this.flags.update((f) => ({ ...f, [k]: on }));
  }

  protected setPageFlag(k: string, on: boolean): void {
    this.pageFlags.update((f) => ({ ...f, [k]: on }));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    const f = this.f();
    const bps = (v: string) => Math.round(parseFloat(v) * 100);
    try {
      const body = {
        shipping_fee_paise: toPaise(f["shipping"]), free_shipping_threshold_paise: toPaise(f["free"]), cod_enabled: this.cod(), cod_fee_paise: toPaise(f["codFee"]),
        cod_max_order_paise: toPaise(f["codMax"]), tcs_bps: bps(f["tcs"]), tds_bps: bps(f["tds"]), commission_gst_bps: bps(f["cgst"]), max_qty_per_item: Number(f["qty"]), shipping_per_kg_paise: toPaise(f["perKg"]), shipping_free_grams: Number(f["freeGrams"]),
        transit_days_same_city: Number(f["city"]), transit_days_same_state: Number(f["state"]), transit_days_national: Number(f["national"]),
        auto_cancel_unconfirmed_hours: Number(f["autoCancel"]), payout_min_paise: toPaise(f["payoutMin"]), low_stock_threshold: Number(f["lowStock"]), ...this.flags(),
        defect_return_days: Number(f["defectDays"]), payout_weekday: Number(f["payDay"]), payout_every_weeks: Number(f["payEvery"]),
        payment_window_minutes: Number(f["payWindow"]), customer_cancel_until: f["cancelUntil"] || "packed", payment_return_mode: f["payReturn"] || "return",
        admin_layout_default: f["adminLayout"] || "sidebar",
        maintenance_mode: this.maintenance(), maintenance_message: f["maintenanceMessage"] ?? "",
        ...Object.fromEntries(PAGE_TEXTS.map(([k]) => [k, f[k] ?? ""])), search_synonyms: f["search_synonyms"] ?? "", ...this.pageFlags(), ...this.apps(),
        ...Object.fromEntries(LIST_FIELDS.map(([k]) => [k, Number(f[k])])),
      };
      if (Object.values(body).some((v) => v === null || (typeof v === "number" && Number.isNaN(v)))) throw new Error("Check that every amount is a number");
      this.s.set(await api<S>("/api/admin/settings", { method: "PUT", body }));
      this.toast.show("Settings saved");
    } catch (err) {
      this.error.set(err instanceof ApiError || err instanceof Error ? err.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
