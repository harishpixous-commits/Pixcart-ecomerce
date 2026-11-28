/* Admin → Growth: one switch and a few numbers per module (loyalty, referral, abandoned carts, flash sales, gift cards,
 * seller scorecard, COD risk, SEO, bulk edit, segments), plus the seller scorecard. Mirrors /api/admin/growth/* in both
 * the .NET and the Python versions. Modules ship OFF; saving a module changes only what is shown here. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { api, ApiError, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Toast } from "../../shared/ui/ui";

type Val = boolean | number | string | string[];
type Section = Record<string, Val>;
type Settings = Record<string, Section>;
type CampaignPreview = { opted_in: number; recipients: number; capped: boolean };
type CampaignRow = { id: string; segment: string; title: string; message: string; link: string; recipients: number; at: string; status?: string; send_at?: string | null };
type Purchase = { id: string; user: string; phone: string | null; amount_paise: number; gateway: string; status: string; error: string; created_at: string };
type Card = { id: string; code: string; note: string; balance_paise: number; initial_paise: number; expires_at: string; status: string };
type LoyaltyView = { enabled: boolean; members_with_points: number; points_held: number; value_held_paise: number; earned_30d: number; redeemed_30d: number; expired_30d: number };
type Reminder = { id: string; customer: string; contact: string | null; stage: number; cart_paise: number; sent_at: string; ordered_after: boolean };
type Seg = { key: string; label: string; count: number };
type Member = { id: string; name: string; phone: string | null; email: string | null; marketing_opt_in: boolean; orders: number; spent_paise: number; last_order_at: string | null };
type Score = { seller_id: string; seller: string; orders: number; late: number; cancelled_by_seller: number; returned: number; late_percent: number; cancel_percent: number; return_percent: number; level: string };

const TITLES: Record<string, { title: string; hint: string }> = {
  loyalty: { title: "Loyalty points", hint: "Customers earn points on delivered orders and spend them at checkout. Optional extras (all off until set): bonus percent for silver and gold, free delivery for silver or gold (silver_free_delivery, gold_free_delivery), extra points on a first delivered order (first_order_points), and points for a published review of something they received (review_points, with review_min_chars as the shortest review that counts). Hiding or deleting a review takes its points back. Unused points lapse after expiry_days (0 = never), oldest first; switch on expiry_reminder to email and notify members 30 days before." },
  referral: { title: "Referral rewards", hint: "A customer shares a code; both sides get store credit after the friend's first order." },
  abandoned_cart: { title: "Abandoned cart reminders", hint: "Remind shoppers who left items in the cart. Optional coupon in the reminder." },
  flash_sales: { title: "Flash sales", hint: "Time-limited discounts. Sellers pick a window within these limits." },
  gift_cards: { title: "Gift cards", hint: "Prepaid codes customers can buy and send." },
  scorecard: { title: "Seller scorecard", hint: "Late shipping, seller cancellations and returns, with warning and critical levels." },
  cod_risk: { title: "Cash on delivery risk", hint: "Limits and blocked pincodes for cash orders." },
  seo: { title: "Search engines", hint: "Sitemap for Google and other search engines." },
  promo_popup: { title: "Welcome popup", hint: "A one-time popup a few seconds after a shopper arrives. It shows again only if you change its words. The link must start with / (a page on this shop); other links are dropped." },
  newsletter: { title: "Newsletter box", hint: "Shows an email box above the shop footer. Addresses are collected on the Newsletter tab. Nothing is emailed from here: use the list yourself or with your email tool." },
  wishlist_share: { title: "Share wishlist", hint: "Shoppers can make a private link to their wishlist. Anyone with the link sees the saved products and the shopper's first name. Shoppers can stop sharing, which kills the link. Switching this off stops every link." },
  return_photos: { title: "Return photos", hint: "Let customers attach photos to a return request. Optionally require one for damaged, faulty, wrong or incomplete items." },
  bulk_edit: { title: "Bulk product edit", hint: "Change price, stock or status of many listings at once." },
  return_reasons: { title: "Return reasons", hint: "Rename a reason shown to customers (label_...) or switch it off (off_...). Leave a label empty to keep the built-in text. Damaged, faulty, wrong or incomplete items keep their special rule." },
  shipping_zones: { title: "Shipping zones", hint: "Add a delivery fee per seller package for remote pincodes. List pincode prefixes separated by commas (for example 744, 19). By default the fee is not added to a package that already ships free. State fees: list state code and fee in paise, like 33:3000, 29:5000, to change the delivery fee for a seller package that does not ship free. Free above by state: list state code and item total in paise, like 33:80000, to set a different free-delivery amount there (a seller's own amount still wins)." },
  bought_together: { title: "Bought together", hint: "Shows a \"Bought together\" row on a product page: other products that were in the same orders (cancelled and unpaid orders do not count). Needs some order history to fill." },
  ship_reminders: { title: "Ship reminders", hint: "Sends the seller one in-app note when a confirmed or packed package has not shipped after the hours set here. Once per package. Packages confirmed longer ago than the max age are skipped." },
  review_reminders: { title: "Review reminders", hint: "Sends one in-app note after a package is delivered if the shopper has not reviewed anything in it. Once per package, after the days set here. Packages older than the max age are skipped." },
  seller_shipping: { title: "Seller free delivery", hint: "Sellers can set their own free-delivery amount (in their Settings) between the minimum and maximum here. Off: every seller uses the marketplace amount. Amounts are in paise (100 paise = 1 rupee)." },
  saved_searches: { title: "Saved searches", hint: "Shoppers follow a search and get an in-app note when new matching products are approved. At most one note per search in the hours set here." },
  campaigns: { title: "Segment campaigns", hint: "Send an in-app message to a customer segment. Only customers who opted in to marketing get it. Needs Segments switched on." },
  segments: { title: "Customer segments", hint: "VIP, new and lapsed customers for targeted offers." },
};

const label = (k: string): string => {
  const base = k.replace(/_paise$/, "").replace(/_percent$/, "").replace(/_/g, " ");
  const unit = k.endsWith("_paise") ? " (₹)" : k.endsWith("_percent") ? " (%)" : k.endsWith("_hours") ? "" : "";
  return base.charAt(0).toUpperCase() + base.slice(1) + unit;
};

@Component({
  selector: "pc-admin-growth-page",
  imports: [PageHeader, Tabs, PageLoader, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Growth" sub="Loyalty, referrals, reminders, flash sales, gift cards, seller quality and risk. Every module starts switched off." />
    <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabs" />
    @if (tab() === "scorecard-view") {
      @if (!score()) { <pc-page-loader /> } @else {
        @if (!scoreOn()) { <p class="mb-3 rounded-lg bg-white p-3 text-sm text-ink-soft">The scorecard is switched off in Settings. Figures below are for information.</p> }
        <div class="overflow-x-auto rounded-xl bg-white">
          <table class="w-full text-left text-sm" data-testid="scorecard">
            <thead><tr class="border-b border-line"><th class="p-3">Seller</th><th class="p-3">Orders</th><th class="p-3">Late</th><th class="p-3">Seller cancels</th><th class="p-3">Returns</th><th class="p-3">Status</th></tr></thead>
            <tbody>
              @for (r of score()!; track r.seller_id) {
                <tr class="border-b border-line/50"><td class="p-3 font-semibold">{{ r.seller }}</td><td class="p-3">{{ r.orders }}</td>
                  <td class="p-3">{{ r.late }} ({{ r.late_percent }}%)</td><td class="p-3">{{ r.cancelled_by_seller }} ({{ r.cancel_percent }}%)</td><td class="p-3">{{ r.returned }} ({{ r.return_percent }}%)</td>
                  <td class="p-3">{{ levelText(r.level) }}</td></tr>
              } @empty { <tr><td class="p-4 text-ink-soft" colspan="6">No orders in the window yet.</td></tr> }
            </tbody>
          </table>
        </div>
      }
    } @else if (tab() === "gift-cards") {
      <div class="flex flex-col gap-4">
        @if (error()) { <pc-error-note [message]="error()!" /> }
        <form class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-4" (submit)="issue($event)" data-testid="gift-issue">
          <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">Amount (₹)</span><input class="rounded-lg border border-line px-3 py-2" [value]="gAmount()" (input)="gAmount.set($any($event.target).value)" aria-label="Gift card amount" /></label>
          <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">How many (1 to 50)</span><input class="rounded-lg border border-line px-3 py-2" [value]="gQty()" (input)="gQty.set($any($event.target).value)" aria-label="Gift card quantity" /></label>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2"><span class="font-semibold">Note</span><input class="rounded-lg border border-line px-3 py-2" [value]="gNote()" (input)="gNote.set($any($event.target).value)" aria-label="Gift card note" /></label>
          <button pcButton type="submit" [loading]="busy()" class="self-start sm:col-span-4">Issue gift cards</button>
          <p class="text-sm text-ink-soft sm:col-span-4">Gift cards must be switched on in Settings first. Codes are shown here and in the list below.</p>
        </form>
        <div class="overflow-x-auto rounded-xl bg-white">
          <table class="w-full text-left text-sm" data-testid="gift-cards">
            <thead><tr class="border-b border-line"><th class="p-3">Code</th><th class="p-3">Balance</th><th class="p-3">Issued</th><th class="p-3">Expires</th><th class="p-3">Status</th><th class="p-3">Note</th><th class="p-3"></th></tr></thead>
            <tbody>
              @for (c of cards(); track c.id) {
                <tr class="border-b border-line/50"><td class="p-3 font-mono font-semibold">{{ c.code }}</td><td class="p-3">{{ rupees(c.balance_paise) }}</td><td class="p-3">{{ rupees(c.initial_paise) }}</td><td class="p-3">{{ date(c.expires_at) }}</td><td class="p-3">{{ c.status }}</td><td class="p-3">{{ c.note }}</td>
                  <td class="p-3">@if (c.status === "active") {<button type="button" class="font-semibold text-vermilion" (click)="voidCard(c)">Void</button>}</td></tr>
              } @empty { <tr><td class="p-4 text-ink-soft" colspan="7">No gift cards yet.</td></tr> }
            </tbody>
          </table>
        </div>
        @if (purchases().length > 0) {
          <div class="overflow-x-auto rounded-xl bg-white">
            <h3 class="p-3 font-semibold">Bought online</h3>
            <table class="w-full text-left text-sm" data-testid="gift-purchases">
              <thead><tr class="border-b border-line"><th class="p-3">Buyer</th><th class="p-3">Amount</th><th class="p-3">Gateway</th><th class="p-3">Status</th><th class="p-3">Started</th><th class="p-3">Note</th><th class="p-3"></th></tr></thead>
              <tbody>
                @for (p of purchases(); track p.id) {
                  <tr class="border-b border-line/50"><td class="p-3">{{ p.user }} {{ p.phone }}</td><td class="p-3">{{ rupees(p.amount_paise) }}</td><td class="p-3">{{ p.gateway }}</td><td class="p-3">{{ p.status }}</td><td class="p-3">{{ date(p.created_at) }}</td><td class="p-3 text-ink-soft">{{ p.status === "created" ? "Waiting for payment, or paid and not yet checked" : p.error }}</td>
                    <td class="p-3">@if (p.status === "created") {<button type="button" class="font-semibold text-peacock" (click)="checkPurchase(p)">Check payment</button>}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    } @else if (tab() === "loyalty") {
      <div class="flex flex-col gap-4" data-testid="loyalty-overview">
        @if (loyaltyView(); as v) {
          @if (!v.enabled) { <p class="rounded-lg bg-white p-4 text-sm">Loyalty points are switched off in Settings.</p> }
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Members holding points</p><p class="mt-1 text-2xl font-semibold">{{ v.members_with_points }}</p></div>
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Points held</p><p class="mt-1 text-2xl font-semibold">{{ v.points_held }}</p></div>
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Value held (what you owe in rewards)</p><p class="mt-1 text-2xl font-semibold">{{ rupees(v.value_held_paise) }}</p></div>
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Earned, last 30 days</p><p class="mt-1 text-2xl font-semibold">{{ v.earned_30d }}</p></div>
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Redeemed, last 30 days</p><p class="mt-1 text-2xl font-semibold">{{ v.redeemed_30d }}</p></div>
            <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Expired, last 30 days</p><p class="mt-1 text-2xl font-semibold">{{ v.expired_30d }}</p></div>
          </div>
        } @else { <p class="rounded-lg bg-white p-4 text-sm">Loading</p> }
      </div>
    } @else if (tab() === "cart-reminders") {
      <div class="flex flex-col gap-4">
        @if (reminders(); as rl) {
          <p class="rounded-lg bg-white p-4 text-sm" data-testid="reminder-summary">{{ rl.sent_30d }} reminders in the last 30 days. {{ rl.ordered_after }} of the latest {{ rl.items.length }} customers ordered afterwards.@if (!rl.enabled) { Reminders are switched off in Settings. }</p>
          <div class="overflow-x-auto rounded-xl bg-white">
            <table class="w-full text-left text-sm" data-testid="reminders">
              <thead><tr class="border-b border-line"><th class="p-3">Customer</th><th class="p-3">Contact</th><th class="p-3">Reminder</th><th class="p-3">Cart</th><th class="p-3">Sent</th><th class="p-3">Ordered after</th></tr></thead>
              <tbody>
                @for (r of rl.items; track r.id) {
                  <tr class="border-b border-line/50"><td class="p-3 font-semibold">{{ r.customer }}</td><td class="p-3">{{ r.contact }}</td><td class="p-3">#{{ r.stage }}</td><td class="p-3">{{ rupees(r.cart_paise) }}</td><td class="p-3">{{ date(r.sent_at) }}</td><td class="p-3">{{ r.ordered_after ? "Yes" : "No" }}</td></tr>
                } @empty { <tr><td class="p-4 text-ink-soft" colspan="6">No reminders sent yet.</td></tr> }
              </tbody>
            </table>
          </div>
        } @else { <pc-page-loader /> }
      </div>
    } @else if (tab() === "newsletter") {
      <div class="flex flex-col gap-4">
        @if (newsletter(); as nl) {
          <p class="rounded-lg bg-white p-4 text-sm" data-testid="newsletter-summary">{{ nl.total }} addresses.@if (!nl.enabled) { The newsletter box is switched off in Settings.}</p>
          <div class="overflow-x-auto rounded-xl bg-white">
            <table class="w-full text-left text-sm" data-testid="newsletter-list">
              <thead><tr class="border-b border-line"><th class="p-3">Email</th><th class="p-3">Joined</th><th class="p-3"><span class="sr-only">Remove</span></th></tr></thead>
              <tbody>
                @for (r of nl.items; track r.id) {
                  <tr class="border-b border-line/50"><td class="p-3 font-semibold">{{ r.email }}</td><td class="p-3">{{ date(r.created_at) }}</td>
                    <td class="p-3 text-right"><button type="button" class="text-sm font-semibold text-red-600 hover:underline" (click)="removeSubscriber(r.id)">Remove</button></td></tr>
                } @empty { <tr><td class="p-4 text-ink-soft" colspan="3">Nobody has signed up yet.</td></tr> }
              </tbody>
            </table>
          </div>
        } @else { <pc-page-loader /> }
      </div>
    } @else if (tab() === "referrals") {
      <div class="flex flex-col gap-4">
        @if (referrals(); as rf) {
          <p class="rounded-lg bg-white p-4 text-sm" data-testid="referral-summary">{{ rf.length }} latest referrals, {{ rewardedCount() }} rewarded.</p>
          <div class="overflow-x-auto rounded-xl bg-white">
            <table class="w-full text-left text-sm" data-testid="referrals">
              <thead><tr class="border-b border-line"><th class="p-3">Referrer</th><th class="p-3">Friend</th><th class="p-3">Status</th><th class="p-3">Reward</th><th class="p-3">Joined</th></tr></thead>
              <tbody>
                @for (r of rf; track $index) {
                  <tr class="border-b border-line/50"><td class="p-3 font-semibold">{{ r.referrer }}</td><td class="p-3">{{ r.friend }}</td><td class="p-3">{{ r.status }}</td><td class="p-3">{{ r.reward_paise ? rupees(r.reward_paise) : "-" }}</td><td class="p-3">{{ date(r.at) }}</td></tr>
                } @empty { <tr><td class="p-4 text-ink-soft" colspan="5">No referrals yet.</td></tr> }
              </tbody>
            </table>
          </div>
        } @else { <pc-page-loader /> }
      </div>
    } @else if (tab() === "campaigns") {
      <div class="flex flex-col gap-4">
        <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
          <p class="text-sm text-ink-soft">Preview first: it counts who would get the message and sends nothing. In-app only, and only to customers who opted in to marketing.</p>
          <select class="rounded-lg border px-3 py-2 text-sm" aria-label="Segment" (change)="cSegment.set($any($event.target).value); cPreview.set(null)">
            @for (g of segs(); track g.key) {<option [value]="g.key" [selected]="g.key === cSegment()">{{ g.label }} ({{ g.count }})</option>}
          </select>
          <input class="rounded-lg border px-3 py-2 text-sm" maxlength="80" placeholder="Title" [value]="cTitle()" (input)="cTitle.set($any($event.target).value); cPreview.set(null)" />
          <textarea class="rounded-lg border px-3 py-2 text-sm" maxlength="300" rows="3" placeholder="Message" [value]="cMessage()" (input)="cMessage.set($any($event.target).value); cPreview.set(null)"></textarea>
          <input class="rounded-lg border px-3 py-2 text-sm" maxlength="200" placeholder="Page to open, like /offers (optional)" [value]="cLink()" (input)="cLink.set($any($event.target).value); cPreview.set(null)" />
          <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">Send later (optional, 2 minutes to 30 days ahead)</span>
            <input type="datetime-local" class="rounded-lg border px-3 py-2 text-sm" [value]="cSendAt()" (input)="cSendAt.set($any($event.target).value); cPreview.set(null)" data-testid="campaign-send-at" />
          </label>
          @if (cSendAt()) {
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="font-semibold">Repeat</span>
              <select class="rounded-lg border px-3 py-2" [value]="cRepeatDays()" (change)="cRepeatDays.set(+$any($event.target).value); cPreview.set(null)" aria-label="Repeat">
                <option value="0">Do not repeat</option><option value="7">Every week</option><option value="14">Every 2 weeks</option><option value="30">Every 30 days</option>
              </select>
              @if (cRepeatDays() > 0) {
                <span>for</span>
                <select class="rounded-lg border px-3 py-2" [value]="cRepeatTimes()" (change)="cRepeatTimes.set(+$any($event.target).value); cPreview.set(null)" aria-label="More times">
                  @for (n of repeatTimeOptions; track n) {<option [value]="n" [selected]="n === cRepeatTimes()">{{ n }} more {{ n === 1 ? "time" : "times" }}</option>}
                </select>
                <span class="text-ink-faint">Cancel the next scheduled one to stop it.</span>
              }
            </div>
          }
          <pc-error-note [message]="error()" />
          <div class="flex items-center gap-2">
            <button pcButton (click)="campaign(true)" [loading]="busy() && !cPreview()" [disabled]="!cTitle().trim() || !cMessage().trim()">Preview</button>
            @if (cPreview(); as p) {
              @if (p.recipients > 0) {<button pcButton variant="buy" (click)="campaign(false)" [loading]="busy()">{{ cSendAt() ? "Schedule for " + p.recipients + " people" : "Send to " + p.recipients }}</button>}
              <span class="text-sm text-ink-soft" data-testid="campaign-preview">{{ p.opted_in }} opted in{{ p.capped ? ", capped at " + p.recipients : "" }}</span>
            }
          </div>
        </section>
        @if (campaigns().length) {
          <div class="overflow-x-auto rounded-xl bg-white">
            <table class="w-full text-left text-sm" data-testid="campaigns">
              <thead><tr class="border-b border-line"><th class="p-3">When</th><th class="p-3">Segment</th><th class="p-3">Title</th><th class="p-3">People</th><th class="p-3">Status</th></tr></thead>
              <tbody>
                @for (c of campaigns(); track c.id) {
                  <tr class="border-b border-line/50"><td class="p-3">{{ date(c.status === "scheduled" && c.send_at ? c.send_at : c.at) }}</td><td class="p-3">{{ c.segment.replaceAll("_", " ") }}</td><td class="p-3 font-semibold">{{ c.title }}</td><td class="p-3">{{ c.status === "scheduled" ? "-" : c.recipients }}</td>
                    <td class="p-3 capitalize">{{ c.status ?? "sent" }}@if (c.status === "scheduled") {<button type="button" class="ml-2 font-semibold text-vermilion" (click)="cancelScheduled(c.id)">Cancel</button>}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    } @else if (tab() === "segments") {
      <div class="flex flex-col gap-4">
        @if (segError()) { <p class="rounded-lg bg-white p-4 text-sm text-ink-soft" data-testid="segments-off">{{ segError() }}</p> }
        <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          @for (g of segs(); track g.key) {
            <button type="button" (click)="openSeg(g.key)" [attr.aria-pressed]="segKey() === g.key" class="rounded-xl bg-white p-4 text-left hover:ring-2 hover:ring-peacock">
              <p class="text-2xl font-bold">{{ g.count }}</p><p class="text-sm text-ink-soft">{{ g.label }}</p></button>
          }
        </div>
        @if (members().length) {
          <div class="overflow-x-auto rounded-xl bg-white">
            <table class="w-full text-left text-sm" data-testid="segment-members">
              <thead><tr class="border-b border-line"><th class="p-3">Customer</th><th class="p-3">Contact</th><th class="p-3">Orders</th><th class="p-3">Spent</th><th class="p-3">Last order</th><th class="p-3">Marketing</th></tr></thead>
              <tbody>
                @for (m of members(); track m.id) {
                  <tr class="border-b border-line/50"><td class="p-3 font-semibold">{{ m.name }}</td><td class="p-3">{{ m.phone || m.email }}</td><td class="p-3">{{ m.orders }}</td><td class="p-3">{{ rupees(m.spent_paise) }}</td><td class="p-3">{{ m.last_order_at ? date(m.last_order_at) : "None" }}</td><td class="p-3">{{ m.marketing_opt_in ? "Opted in" : "No" }}</td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    } @else if (!s()) {
      <pc-page-loader />
    } @else {
      <form class="flex flex-col gap-4" (submit)="save($event)">
        @if (error()) { <pc-error-note [message]="error()!" /> }
        @for (sec of sections(); track sec) {
          <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" [attr.data-testid]="'growth-' + sec">
            <div class="sm:col-span-2"><h2 class="text-lg font-semibold">{{ titles[sec].title }}</h2><p class="text-sm text-ink-soft">{{ titles[sec].hint }}</p></div>
            @for (k of keys(sec); track k) {
              @if (kind(sec, k) === "bool") {
                <label class="flex items-center gap-3 rounded-lg border border-line p-3"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="s()![sec][k]" (change)="set(sec, k, $any($event.target).checked)" /> <span class="font-semibold">{{ label(k === 'enabled' ? 'Switched on' : k) }}</span></label>
              } @else {
                <label class="flex flex-col gap-1 text-sm"><span class="font-semibold">{{ label(k) }}</span>
                  <input class="rounded-lg border border-line px-3 py-2" [value]="show(sec, k)" (input)="edit(sec, k, $any($event.target).value)" [attr.aria-label]="titles[sec].title + ' ' + label(k)" /></label>
              }
            }
          </section>
        }
        <button pcButton type="submit" [loading]="busy()" class="self-start">Save growth settings</button>
      </form>
    }
  `,
})
export class AdminGrowthPage {
  private readonly toast = inject(Toast);
  protected readonly titles = TITLES;
  protected readonly label = label;
  protected readonly tab = signal("settings");
  protected readonly tabs = [{ value: "settings", label: "Settings" }, { value: "scorecard-view", label: "Seller scorecard" }, { value: "gift-cards", label: "Gift cards" }, { value: "segments", label: "Segments" }, { value: "campaigns", label: "Campaigns" }, { value: "loyalty", label: "Loyalty" }, { value: "cart-reminders", label: "Cart reminders" }, { value: "referrals", label: "Referrals" }, { value: "newsletter", label: "Newsletter" }];
  protected readonly rupees = rupees;
  protected readonly date = date;
  protected readonly cards = signal<Card[]>([]);
  protected readonly purchases = signal<Purchase[]>([]);
  protected readonly newsletter = signal<{ enabled: boolean; total: number; items: { id: string; email: string; created_at: string }[] } | null>(null);
  protected readonly referrals = signal<{ referrer: string; friend: string; status: string; reward_paise: number; at: string }[] | null>(null);
  protected rewardedCount(): number { return (this.referrals() ?? []).filter((r) => r.status === "rewarded").length; }
  protected readonly reminders = signal<{ enabled: boolean; sent_30d: number; ordered_after: number; items: Reminder[] } | null>(null);
  protected readonly gAmount = signal("500");
  protected readonly gQty = signal("1");
  protected readonly gNote = signal("");
  protected readonly cSegment = signal("never_ordered");
  protected readonly cTitle = signal("");
  protected readonly cMessage = signal("");
  protected readonly cLink = signal("");
  protected readonly cSendAt = signal("");
  protected readonly cRepeatDays = signal(0);
  protected readonly cRepeatTimes = signal(4);
  protected readonly repeatTimeOptions = [1, 2, 4, 8, 12];
  protected readonly cPreview = signal<CampaignPreview | null>(null);
  protected readonly campaigns = signal<CampaignRow[]>([]);
  protected readonly segs = signal<Seg[]>([]);
  protected readonly segKey = signal("");
  protected readonly members = signal<Member[]>([]);
  protected readonly segError = signal<string | null>(null);
  protected readonly s = signal<Settings | null>(null);
  protected readonly score = signal<Score[] | null>(null);
  protected readonly scoreOn = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly loyaltyView = signal<LoyaltyView | null>(null);
  private readonly text = new Map<string, string>();

  private loadNewsletter(): void {
    api<{ enabled: boolean; total: number; items: { id: string; email: string; created_at: string }[] }>("/api/admin/growth/newsletter").then((x) => this.newsletter.set(x)).catch(quietly);
  }

  protected async removeSubscriber(id: string): Promise<void> {
    await api(`/api/admin/growth/newsletter/${id}`, { method: "DELETE" }).catch(quietly);
    this.loadNewsletter();
  }

  constructor() {
    api<{ settings: Settings }>("/api/admin/growth/settings").then((x) => this.s.set(x.settings)).catch(quietly);
    this.loadCards();
    this.loadCampaigns();
    api<LoyaltyView>("/api/admin/growth/loyalty").then((x) => this.loyaltyView.set(x)).catch(quietly);
    api<{ enabled: boolean; sent_30d: number; ordered_after: number; items: Reminder[] }>("/api/admin/growth/cart-reminders").then((x) => this.reminders.set(x)).catch(quietly);
    this.loadNewsletter();
    api<{ items: { referrer: string; friend: string; status: string; reward_paise: number; at: string }[] }>("/api/admin/growth/referrals").then((x) => this.referrals.set(x.items)).catch(quietly);
    api<{ segments: Seg[] }>("/api/admin/growth/segments").then((x) => this.segs.set(x.segments)).catch((e) => this.segError.set(e instanceof ApiError ? e.message : null));
    api<{ enabled: boolean; items: Score[] }>("/api/admin/growth/scorecard").then((x) => { this.score.set(x.items); this.scoreOn.set(x.enabled); }).catch(quietly);
  }

  private loadCampaigns(): void {
    api<{ items: CampaignRow[] }>("/api/admin/growth/campaigns").then((x) => this.campaigns.set(x.items)).catch(quietly);
  }

  protected async cancelScheduled(id: string): Promise<void> {
    try {
      await api(`/api/admin/growth/campaigns/${id}`, { method: "DELETE" });
      this.toast.show("Campaign cancelled");
      this.loadCampaigns();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not cancel", "error");
    }
  }

  protected async campaign(dry: boolean): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = { segment: this.cSegment(), title: this.cTitle(), message: this.cMessage(), link: this.cLink(), dry_run: dry, send_at: this.cSendAt() ? new Date(this.cSendAt()).toISOString() : null, repeat_days: this.cSendAt() ? this.cRepeatDays() : 0, repeat_times: this.cSendAt() && this.cRepeatDays() ? this.cRepeatTimes() : 0 };
      const r = await api<CampaignPreview>("/api/admin/growth/campaigns", { method: "POST", body });
      if (dry) this.cPreview.set(r);
      else {
        this.cPreview.set(null);
        this.cTitle.set("");
        this.cMessage.set("");
        this.cLink.set("");
        const scheduled = this.cSendAt() !== "";
        this.cSendAt.set("");
        this.cRepeatDays.set(0);
        this.toast.show(scheduled ? "Campaign scheduled" : `Sent to ${r.recipients} customers`);
        this.loadCampaigns();
      }
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not send");
    } finally {
      this.busy.set(false);
    }
  }

  private loadCards(): void {
    api<{ items: Card[] }>("/api/admin/growth/gift-cards").then((x) => this.cards.set(x.items)).catch(quietly);
    api<{ items: Purchase[] }>("/api/admin/growth/gift-card-purchases").then((x) => this.purchases.set(x.items)).catch(quietly);
  }

  protected async checkPurchase(p: Purchase): Promise<void> {
    try {
      const r = await api<{ status: string }>(`/api/admin/growth/gift-card-purchases/${p.id}/check`, { method: "POST", body: {} });
      this.toast.show(r.status === "issued" ? "Paid. The card was issued." : r.status === "failed" ? "The payment failed." : "Not paid yet.");
      this.loadCards();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not check");
    }
  }

  protected async issue(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const amount = Math.round((Number(this.gAmount().replace(/[^\d.]/g, "")) || 0) * 100);
      const quantity = Number(this.gQty()) || 1;
      await api("/api/admin/growth/gift-cards", { method: "POST", body: { amount_paise: amount, quantity, note: this.gNote().trim() } });
      this.toast.show(quantity > 1 ? "Gift cards issued" : "Gift card issued");
      this.loadCards();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not issue");
    } finally {
      this.busy.set(false);
    }
  }

  protected async voidCard(c: Card): Promise<void> {
    try {
      await api(`/api/admin/growth/gift-cards/${c.id}/void`, { method: "POST", body: {} });
      this.loadCards();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not void");
    }
  }

  protected async openSeg(key: string): Promise<void> {
    this.segKey.set(key);
    try {
      this.members.set((await api<{ items: Member[] }>("/api/admin/growth/segments", { query: { segment: key } })).items);
    } catch (x) {
      this.segError.set(x instanceof ApiError ? x.message : null);
    }
  }

  protected sections = (): string[] => Object.keys(this.s() ?? {}).filter((k) => TITLES[k]);
  protected keys = (sec: string): string[] => Object.keys(this.s()![sec]).sort((a, b) => (a === "enabled" ? -1 : b === "enabled" ? 1 : 0));
  protected kind = (sec: string, k: string): string => { const v = this.s()![sec][k]; return typeof v === "boolean" ? "bool" : typeof v === "number" ? "num" : Array.isArray(v) ? "list" : "text"; };
  protected levelText = (l: string): string => ({ ok: "Good", warning: "Warning", critical: "Critical", not_enough_orders: "Not enough orders" } as Record<string, string>)[l] ?? l;

  protected show(sec: string, k: string): string {
    const key = sec + "." + k;
    if (this.text.has(key)) return this.text.get(key)!;
    const v = this.s()![sec][k];
    return Array.isArray(v) ? v.join(", ") : typeof v === "number" && k.endsWith("_paise") ? String(v / 100) : String(v);
  }

  protected set(sec: string, k: string, v: Val): void {
    this.s.update((s) => (s ? { ...s, [sec]: { ...s[sec], [k]: v } } : s));
  }

  protected edit(sec: string, k: string, raw: string): void {
    this.text.set(sec + "." + k, raw);
    const kind = this.kind(sec, k);
    if (kind === "list") this.set(sec, k, raw.split(",").map((x) => x.trim()).filter(Boolean));
    else if (kind === "num") this.set(sec, k, Math.round((Number(raw.replace(/[^\d.]/g, "")) || 0) * (k.endsWith("_paise") ? 100 : 1)));
    else this.set(sec, k, raw);
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const s = this.s();
    if (!s) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const body: Settings = {};
      for (const sec of this.sections()) body[sec] = s[sec];
      const x = await api<{ settings: Settings }>("/api/admin/growth/settings", { method: "PUT", body });
      this.text.clear();
      this.s.set(x.settings);
      this.toast.show("Growth settings saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
