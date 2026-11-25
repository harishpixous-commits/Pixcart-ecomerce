/*
 * Product page building blocks: offers, service icons, key specifications, seller snapshot, share,
 * "report an issue", "ask a question", the phone buy bar and the browsing-history rail. Each block is
 * switched on or off in Admin → Product page. Port of components/pdp.tsx.
 */

import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked,
} from "@angular/core";
import {
  Award, BadgeCheck, Ban, Banknote, Bell, BellRing, Check, ChevronDown, Clock, Copy, FileText, Flag, Link2, Mail, MessageCircleQuestion,
  RotateCcw, Share2, ShieldCheck, Star, Tag, ThumbsUp, Truck, type LucideIconData,
} from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { date as fmtDate, rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { ProductCard, ProductOffer, ProductPage, SellerSnapshot } from "../../core/types";
import { readViewed } from "../../core/wishlist";
import { ProductRail } from "../../shared/product/product";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, Modal, Textarea, Toast } from "../../shared/ui/ui";

@Component({
  selector: "pc-unit-price",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (up(); as u) {<span [class]="'text-ink-soft ' + cls()">({{ rupees(u.paise) }} / {{ u.per }})</span>}`,
})
export class UnitPrice {
  readonly up = input<{ paise: number; per: string } | null | undefined>(null);
  readonly cls = input("", { alias: "unitClass" });
  protected readonly rupees = rupees;
}

/* ---------------------------------------------------------------- offers */

@Component({
  selector: "pc-offers-block",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (offers().length) {
      <section aria-labelledby="offers-h">
        <h2 id="offers-h" class="mb-2 flex items-center gap-1.5 text-base font-semibold">
          <svg [pcIcon]="Tag" class="h-4 w-4 text-vermilion" /> Save extra with {{ offers().length }} {{ offers().length === 1 ? "offer" : "offers" }}
        </h2>
        <div class="scroll-x -mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
          @for (o of offers(); track o.code) {
            <div class="flex w-[210px] shrink-0 snap-start flex-col rounded-lg border border-line p-3 shadow-sm" data-testid="offer">
              <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">{{ o.source === "seller" ? "Seller offer" : "Store offer" }}</p>
              <p class="font-semibold leading-snug">{{ o.title }}</p>
              <p class="line-clamp-2 min-h-[2.5em] text-[13px] text-ink-soft">{{ o.description || o.terms || "On this product" }}</p>
              @if (o.ends_at) {<p class="text-xs text-vermilion">Ends {{ fmtDate(o.ends_at) }}</p>}
              <button type="button" (click)="copy(o.code)"
                class="mt-2 flex items-center justify-between rounded-md border border-dashed border-peacock bg-peacock-light px-2 py-1 font-mono text-sm font-semibold text-peacock hover:bg-peacock hover:text-white"
                [attr.aria-label]="'Copy code ' + o.code">
                {{ o.code }}
                <svg [pcIcon]="copied() === o.code ? Check : Copy" class="h-4 w-4" />
              </button>
            </div>
          }
        </div>
      </section>
    }
  `,
})
export class OffersBlock {
  readonly offers = input.required<ProductOffer[]>();
  private readonly toast = inject(Toast);
  protected readonly copied = signal("");
  protected readonly Tag = Tag;
  protected readonly Check = Check;
  protected readonly Copy = Copy;
  protected readonly fmtDate = fmtDate;
  protected async copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard blocked: the code is on screen anyway */
    }
    this.copied.set(code);
    this.toast.show(`Code ${code} copied. Apply it at checkout.`);
    setTimeout(() => this.copied.set(""), 2500);
  }
}

/* ---------------------------------------------------------------- service icons */

@Component({
  selector: "pc-service-icons",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ul class="scroll-x -mx-1 flex gap-1 overflow-x-auto px-1 py-1" aria-label="Services">
      @for (it of items(); track it.label) {
        <li class="flex w-[84px] shrink-0 flex-col items-center gap-1 text-center" [attr.title]="it.detail">
          <span [class]="'flex h-11 w-11 items-center justify-center rounded-full bg-peacock-light ' + (it.tone ?? 'text-peacock')"><svg [pcIcon]="it.icon" class="h-5 w-5" /></span>
          <span class="text-[12px] font-medium leading-tight text-peacock">{{ it.label }}</span>
        </li>
      }
    </ul>
  `,
})
export class ServiceIcons {
  readonly p = input.required<ProductPage>();
  readonly price = input.required<number>();
  private readonly site = inject(SiteService).site;
  protected readonly items = computed(() => {
    const site = this.site(), p = this.p();
    const free = this.price() >= site.free_shipping_threshold_paise;
    const items: { icon: LucideIconData; label: string; detail: string; tone?: string }[] = [
      free
        ? { icon: Truck, label: "Free delivery", detail: "No delivery charge on this item" }
        : { icon: Truck, label: `Delivery ${rupees(site.shipping_fee_paise ?? 4000)}`, detail: `Free when you buy ${rupees(site.free_shipping_threshold_paise)} or more from this seller` },
    ];
    if (site.cod_enabled) items.push({ icon: Banknote, label: "Pay on delivery", detail: "Cash, UPI or card when the parcel arrives" });
    items.push(p.return_window_days > 0
      ? { icon: RotateCcw, label: `${p.return_window_days}-day returns`, detail: `Return within ${p.return_window_days} days of delivery if something is wrong` }
      : { icon: Ban, label: "Not returnable", detail: "This item cannot be returned once delivered", tone: "text-ink-faint" });
    if (p.seller_snapshot?.top_seller) items.push({ icon: Award, label: "Top seller", detail: "Highly rated seller with many recent orders" });
    items.push({ icon: BadgeCheck, label: "Verified seller", detail: "Identity, GST and bank details checked" });
    items.push({ icon: FileText, label: "GST invoice", detail: "Download a GST invoice for every order" });
    if (site.online_payments !== false) items.push({ icon: ShieldCheck, label: "Secure payment", detail: "UPI, cards and net banking through a certified gateway" });
    return items;
  });
}

/* ---------------------------------------------------------------- key specs */

@Component({
  selector: "pc-key-specs",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (all().length) {
      <table class="w-full max-w-md text-[14px]">
        <tbody>
          @for (r of all(); track r.label) {
            <tr>
              <th scope="row" class="w-40 py-1 pr-4 text-left align-top font-semibold">{{ r.label }}</th>
              <td class="py-1 text-ink-soft">{{ r.value }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class KeySpecs {
  readonly rows = input.required<{ label: string; value: string }[]>();
  readonly extra = input<{ label: string; value: string }[]>([]);
  protected readonly all = computed(() => [...this.rows(), ...this.extra()]);
}

@Component({
  selector: "pc-about-this-item",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items().length) {
      <section aria-labelledby="about-h">
        <h2 id="about-h" class="mb-1.5 text-lg font-semibold">About this item</h2>
        <ul class="list-disc space-y-1 pl-5 text-[15px] text-ink-soft">
          @for (h of shown(); track h) {<li>{{ h }}</li>}
        </ul>
        @if (items().length > 5) {
          <button type="button" (click)="all.set(!all())" class="mt-1 flex items-center gap-1 text-sm font-semibold text-peacock">
            {{ all() ? "Show less" : "Show " + (items().length - 5) + " more" }} <svg [pcIcon]="ChevronDown" [class]="all() ? 'h-4 w-4 transition rotate-180' : 'h-4 w-4 transition'" />
          </button>
        }
      </section>
    }
  `,
})
export class AboutThisItem {
  readonly items = input.required<string[]>();
  private readonly lists = inject(SiteService).lists;
  protected readonly all = signal(false);
  protected readonly ChevronDown = ChevronDown;
  protected readonly shown = computed(() => (this.all() ? this.items() : this.items().slice(0, Math.max(1, this.lists().highlights_shown))));
}

/* ---------------------------------------------------------------- seller snapshot */

@Component({
  selector: "pc-seller-snapshot",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl border border-line p-4" aria-labelledby="seller-snap-h" data-testid="seller-snapshot">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h2 id="seller-snap-h" class="text-base font-semibold">
          <a [pcLink]="'/store/' + seller().slug" class="hover:text-peacock hover:underline">{{ seller().name }}</a>
        </h2>
        @if (snap().top_seller) {<span class="flex items-center gap-1 rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-ink"><svg [pcIcon]="Award" class="h-3.5 w-3.5" /> Top seller</span>}
      </div>
      <ul class="flex flex-col gap-1.5 text-sm text-ink-soft">
        @for (s of stats(); track s.text) {<li class="flex gap-2"><svg [pcIcon]="s.icon" class="mt-0.5 h-4 w-4 shrink-0 text-peacock" />{{ s.text }}</li>}
      </ul>
      <a [pcLink]="'/store/' + seller().slug" class="mt-3 inline-block text-sm font-semibold text-peacock hover:underline">Visit the store</a>
    </section>
  `,
})
export class SellerSnapshotCard {
  readonly seller = input.required<ProductPage["seller"]>();
  readonly snap = input.required<SellerSnapshot>();
  private readonly site = inject(SiteService).site;
  protected readonly Award = Award;
  protected readonly stats = computed(() => {
    const snap = this.snap();
    const tenure = snap.years >= 1 ? `${snap.years}+ ${snap.years === 1 ? "year" : "years"}` : snap.months >= 1 ? `${snap.months} ${snap.months === 1 ? "month" : "months"}` : "New";
    const stats: { icon: LucideIconData; text: string }[] = [];
    if (snap.positive_pct !== null) stats.push({ icon: ThumbsUp, text: `${snap.positive_pct}% positive ratings from ${snap.rating_count.toLocaleString("en-IN")} customers` });
    else if (snap.rating_count > 0) stats.push({ icon: Star, text: `${snap.rating_avg.toFixed(1)} out of 5 from ${snap.rating_count} ratings` });
    if (snap.orders_90d) stats.push({ icon: Truck, text: `${snap.orders_90d} orders in the last 3 months` });
    if (snap.on_time_pct !== null) stats.push({ icon: Clock, text: `${snap.on_time_pct}% of orders dispatched on time` });
    stats.push({ icon: BadgeCheck, text: `${tenure} on ${this.site().brand_name || "this store"}` });
    return stats;
  });
}

/* ---------------------------------------------------------------- share */

@Component({
  selector: "pc-share-button",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative block" },
  template: `
    <button type="button" (click)="click()" [attr.aria-expanded]="open()" class="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink-soft ring-1 ring-line hover:bg-mist" data-testid="share">
      <svg [pcIcon]="Share2" class="h-4 w-4" /> Share
    </button>
    @if (open()) {
      <div class="absolute right-0 top-12 z-40 w-48 overflow-hidden rounded-lg bg-white py-1 text-sm shadow-xl ring-1 ring-line" role="menu">
        @for (l of links(); track l.label) {
          <a [href]="l.href" target="_blank" rel="noopener noreferrer" class="block px-4 py-2 hover:bg-mist" role="menuitem" (click)="open.set(false)">{{ l.label }}</a>
        }
        <a [href]="mail()" class="flex items-center gap-2 px-4 py-2 hover:bg-mist" role="menuitem"><svg [pcIcon]="Mail" class="h-4 w-4" /> Email</a>
        <button type="button" (click)="copy()" class="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist" role="menuitem"><svg [pcIcon]="Link2" class="h-4 w-4" /> Copy link</button>
      </div>
    }
  `,
})
export class ShareButton {
  readonly title = input.required<string>();
  private readonly toast = inject(Toast);
  private readonly path = inject(RouteState).pathname;
  protected readonly open = signal(false);
  protected readonly Share2 = Share2;
  protected readonly Mail = Mail;
  protected readonly Link2 = Link2;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /** the page's address (read again when the product changes) */
  private readonly url = computed(() => {
    this.path();
    return window.location.href.split("#")[0];
  });
  protected readonly links = computed(() => {
    const url = this.url();
    const text = encodeURIComponent(`${this.title()} ${url}`);
    return [
      { label: "WhatsApp", href: `https://wa.me/?text=${text}` },
      { label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
      { label: "X (Twitter)", href: `https://twitter.com/intent/tweet?text=${text}` },
    ];
  });
  protected readonly mail = computed(() => `mailto:?subject=${encodeURIComponent(this.title())}&body=${encodeURIComponent(this.url())}`);

  constructor() {
    // closes on a click outside
    effect((onCleanup) => {
      if (!this.open()) return;
      const close = (e: MouseEvent) => { if (!this.host.contains(e.target as Node)) this.open.set(false); };
      document.addEventListener("mousedown", close);
      onCleanup(() => document.removeEventListener("mousedown", close));
    });
  }

  protected async click() {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await nav.share({ title: this.title(), url: this.url() });
        return;
      } catch {
        /* cancelled: fall through to the menu */
      }
    }
    this.open.update((o) => !o);
  }

  protected async copy() {
    try {
      await navigator.clipboard.writeText(this.url());
      this.toast.show("Link copied");
    } catch {
      this.toast.show("Copy the address from the address bar", "error");
    }
    this.open.set(false);
  }
}

/* ---------------------------------------------------------------- report an issue */

const REPORT_REASONS: [string, string][] = [
  ["wrong_info", "Wrong or missing product information"],
  ["counterfeit", "Fake or counterfeit product"],
  ["unsafe", "Unsafe, expired or harmful"],
  ["prohibited", "Not allowed to be sold"],
  ["offensive", "Offensive images or text"],
  ["price", "Lower price elsewhere / misleading price"],
  ["other", "Something else"],
];

@Component({
  selector: "pc-report-product",
  imports: [Icon, PcLink, Modal, Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!user()) {
      <a [pcLink]="'/login?next=' + enc(path())" class="flex items-center gap-1.5 text-sm text-ink-faint hover:text-peacock"><svg [pcIcon]="Flag" class="h-4 w-4" /> Sign in to report an issue with this product</a>
    } @else {
      <button type="button" (click)="open.set(true)" class="flex items-center gap-1.5 text-sm text-ink-faint hover:text-peacock" data-testid="report-product">
        <svg [pcIcon]="Flag" class="h-4 w-4" /> Report an issue with this product
      </button>
      <pc-modal [open]="open()" (close)="open.set(false)" title="Report an issue with this product">
        <form (submit)="send($event)" class="flex flex-col gap-3">
          <fieldset class="flex flex-col gap-1.5">
            <legend class="mb-1 text-sm font-semibold">What is wrong?</legend>
            @for (r of REASONS; track r[0]) {
              <label [class]="reason() === r[0] ? 'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm border-peacock bg-peacock-light' : 'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm border-line hover:border-peacock/50'">
                <input type="radio" name="report-reason" [value]="r[0]" [checked]="reason() === r[0]" (change)="reason.set(r[0]); error.set('')" class="accent-peacock" />
                {{ r[1] }}
              </label>
            }
          </fieldset>
          @if (reason() === "price") {
            <label class="flex flex-col gap-1 text-sm">
              <span class="font-semibold">Where did you see it? (optional)</span>
              <input [value]="url()" (input)="url.set($any($event.target).value)" placeholder="https://" class="h-10 rounded-lg border border-line px-3" />
            </label>
          }
          <label class="flex flex-col gap-1 text-sm">
            <span class="font-semibold">Details {{ needsNote() ? "" : "(optional)" }}</span>
            <textarea pcTextarea rows="3" maxlength="2000" [value]="note()" (input)="note.set($any($event.target).value)" placeholder="What did you notice?"></textarea>
          </label>
          @if (error()) {<p class="text-sm text-vermilion">{{ error() }}</p>}
          <p class="text-xs text-ink-faint">Our team checks every report. The seller sees what was reported, not who reported it.</p>
          <button pcButton type="submit" [loading]="busy()">Send report</button>
        </form>
      </pc-modal>
    }
  `,
})
export class ReportProduct {
  readonly slug = input.required<string>();
  protected readonly user = inject(SessionService).user;
  protected readonly path = inject(RouteState).pathname;
  private readonly toast = inject(Toast);
  protected readonly Flag = Flag;
  protected readonly REASONS = REPORT_REASONS;
  protected readonly enc = encodeURIComponent;
  protected readonly open = signal(false);
  protected readonly reason = signal("");
  protected readonly note = signal("");
  protected readonly url = signal("");
  protected readonly error = signal("");
  protected readonly busy = signal(false);
  protected readonly needsNote = computed(() => ["wrong_info", "other", "counterfeit", "unsafe"].includes(this.reason()));

  protected async send(e: Event) {
    e.preventDefault();
    if (!this.reason()) return this.error.set("Choose what is wrong");
    if (this.needsNote() && this.note().trim().length < 10) return this.error.set("Tell us a little more (at least 10 characters)");
    this.busy.set(true);
    this.error.set("");
    try {
      await api(`/api/catalog/products/${this.slug()}/report`, { method: "POST", body: { reason: this.reason(), note: this.note(), url: this.url() } });
      this.open.set(false);
      this.reason.set("");
      this.note.set("");
      this.url.set("");
      this.toast.show("Thank you. Our team will look into it.");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not send the report");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- ask a question */

@Component({
  selector: "pc-ask-about-product",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" [class]="cls()" (click)="ask()"><svg [pcIcon]="MessageCircleQuestion" class="h-4 w-4" /> Ask a question</button>
  `,
})
export class AskAboutProduct {
  readonly title = input.required<string>();
  readonly extra = input("", { alias: "askClass" });
  protected readonly MessageCircleQuestion = MessageCircleQuestion;
  protected readonly cls = computed(() => cx("flex items-center gap-1.5 text-sm font-semibold text-peacock hover:underline", this.extra()));
  protected ask() {
    window.dispatchEvent(new CustomEvent("shop-assistant:open", { detail: { text: `About "${this.title().slice(0, 80)}": ` } }));
  }
}

/* ---------------------------------------------------------------- phone buy bar */

@Component({
  selector: "pc-sticky-buy-bar",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="cls()" [attr.aria-hidden]="!show()" data-testid="buy-bar">
      <div class="mx-auto flex max-w-shop items-center gap-3">
        @if (image()) {<img [src]="image()" alt="" class="hidden h-10 w-10 rounded object-contain sm:block" />}
        <div class="min-w-0 flex-1">
          <p class="hidden truncate text-sm sm:block">{{ title() }}</p>
          <p class="font-display text-lg font-bold leading-tight">{{ rupees(price()) }} @if (mrp() > price()) {<span class="text-sm font-normal text-ink-faint line-through">{{ rupees(mrp()) }}</span>}</p>
        </div>
        <button pcButton variant="cart" (click)="add.emit()" [disabled]="disabled()" [loading]="busy() === 'cart'" [attr.tabindex]="show() ? 0 : -1">Add to cart</button>
        <button pcButton variant="buy" (click)="buy.emit()" [disabled]="disabled()" [loading]="busy() === 'buy'" [attr.tabindex]="show() ? 0 : -1">Buy now</button>
      </div>
    </div>
  `,
})
export class StickyBuyBar {
  readonly watch = input.required<HTMLElement | undefined>();
  readonly price = input.required<number>();
  readonly mrp = input.required<number>();
  readonly title = input.required<string>();
  readonly image = input("");
  readonly disabled = input(false);
  readonly busy = input<"cart" | "buy" | null>(null);
  readonly add = output<void>();
  readonly buy = output<void>();
  protected readonly rupees = rupees;
  protected readonly show = signal(false);
  protected readonly cls = computed(() => cx(
    "fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform sm:bottom-0 lg:hidden",
    this.show() ? "translate-y-0" : "pointer-events-none translate-y-[150%]"));

  constructor() {
    effect((onCleanup) => {
      const el = this.watch();
      if (!el) return;
      // Shown whenever the page's own buttons are out of sight (above or below), as in shopping apps.
      const io = new IntersectionObserver(([e]) => this.show.set(!e.isIntersecting), { threshold: 0 });
      io.observe(el);
      onCleanup(() => io.disconnect());
    });
    effect(() => {
      if (this.show()) document.body.dataset["buyBar"] = "1";
      else delete document.body.dataset["buyBar"];
    });
    inject(DestroyRef).onDestroy(() => delete document.body.dataset["buyBar"]);
  }
}

/* ---------------------------------------------------------------- browsing history */

@Component({
  selector: "pc-recently-viewed-rail",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items().length >= 1) {
      <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="recent-h">
        <h2 id="recent-h" class="mb-3 text-xl font-semibold">Your browsing history</h2>
        <div class="scroll-x flex gap-3 overflow-x-auto">
          @for (x of items(); track x.id) {
            <a [pcLink]="'/p/' + x.slug" class="w-32 shrink-0 hover:text-peacock">
              <img [src]="x.image" [alt]="x.title" class="mb-1 aspect-square w-full rounded-lg bg-mist object-contain" />
              <p class="line-clamp-2 text-sm">{{ x.title }}</p>
              <p class="font-display font-bold">{{ rupees(x.price) }}</p>
            </a>
          }
        </div>
      </section>
    }
  `,
})
export class RecentlyViewedRail {
  readonly currentId = input.required<string>();
  protected readonly rupees = rupees;
  // read from this browser's storage once per product (the product page records the visit first)
  private readonly raw = signal<ReturnType<typeof readViewed>>([]);
  protected readonly items = computed(() => this.raw().filter((x) => x.id !== this.currentId()));
  constructor() {
    effect(() => {
      this.currentId();
      untracked(() => this.raw.set(readViewed()));
    });
  }
}

/* ---------------------------------------------------------------- sponsored rail and notify me */

@Component({
  selector: "pc-sponsored-rail",
  imports: [ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (limit() > 0 && items().length) {
      <pc-product-rail title="Sponsored products related to this item" [items]="items()" note="Sponsored" />
    }
  `,
})
export class SponsoredRail {
  readonly slug = input.required<string>();
  private readonly lists = inject(SiteService).lists;
  protected readonly limit = computed(() => this.lists().sponsored_on_product);
  protected readonly items = signal<ProductCard[]>([]);
  constructor() {
    effect((onCleanup) => {
      const slug = this.slug(), limit = this.limit();
      if (limit <= 0) return;
      let live = true;
      api<{ items: ProductCard[] }>("/api/ads/serve", { query: { placement: "product", product: slug, limit } })
        .then((r) => { if (live) this.items.set(r.items); }).catch(() => {});
      onCleanup(() => (live = false));
    });
  }
}

/** "Notify me when available" for an out-of-stock version. */
@Component({
  selector: "pc-notify-me",
  imports: [Icon, PcLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!user()) {
      <a [pcLink]="'/login?next=' + enc(path())" class="flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-peacock font-semibold text-peacock hover:bg-peacock-light" data-testid="notify-me">
        <svg [pcIcon]="Bell" class="h-5 w-5" /> Sign in to get notified
      </a>
    } @else if (on()) {
      <div class="flex flex-col gap-1 rounded-xl bg-leaf-light p-3 text-sm" data-testid="notify-me">
        <p class="flex items-center gap-1.5 font-semibold text-leaf"><svg [pcIcon]="BellRing" class="h-4 w-4" /> We will notify you when it is back</p>
        <button type="button" (click)="toggle()" [disabled]="busy()" class="self-start text-ink-soft hover:text-vermilion">Stop this alert</button>
      </div>
    } @else {
      <button pcButton variant="secondary" size="lg" (click)="toggle()" [loading]="busy()" class="w-full rounded-full" data-testid="notify-me"><svg [pcIcon]="Bell" class="h-5 w-5" /> Notify me when available</button>
    }
  `,
})
export class NotifyMe {
  readonly variantId = input.required<string>();
  private readonly session = inject(SessionService);
  protected readonly user = this.session.user;
  protected readonly path = inject(RouteState).pathname;
  private readonly toast = inject(Toast);
  protected readonly enc = encodeURIComponent;
  protected readonly Bell = Bell;
  protected readonly BellRing = BellRing;
  private readonly state = signal<{ id: string; on: boolean } | null>(null);
  protected readonly busy = signal(false);
  protected readonly on = computed(() => this.state()?.id === this.variantId() && this.state()!.on);
  constructor() {
    effect((onCleanup) => {
      const id = this.variantId();
      if (!this.session.ready() || !this.user()) return;
      let live = true;
      api<{ stock: { variant_id: string }[] }>("/api/alerts", { query: { variant_id: id } })
        .then((r) => { if (live) this.state.set({ id, on: r.stock.length > 0 }); }).catch(() => {});
      onCleanup(() => (live = false));
    });
  }
  protected async toggle() {
    const id = this.variantId(), on = this.on();
    this.busy.set(true);
    try {
      if (on) await api(`/api/alerts/stock/${id}`, { method: "DELETE" });
      else await api("/api/alerts/stock", { method: "POST", body: { variant_id: id } });
      this.state.set({ id, on: !on });
      this.toast.show(on ? "Alert removed" : "We will tell you as soon as it is back");
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update the alert", "error");
    } finally {
      this.busy.set(false);
    }
  }
}

