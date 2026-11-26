/*
 * The delivery partner app frame: who the partner is (PartnerService), which screen they may see (sign-in,
 * registration, approved), and the mobile-first shell with the online switch, a bottom tab bar on phones and a side
 * menu on larger screens. Port of components/delivery/app.tsx (the gate itself is delivery-layout.ts):
 *   loadDeliveryOptions(), PartnerService, <pc-full-loader label>, <pc-no-requests-notice [inactive] [carrying]>,
 *   <pc-simple-frame>, <pc-delivery-shell>, <pc-online-switch [large]>. The feed (DeliveryFeedService, <pc-offer-popup>)
 *   is in ../components/feed.ts, the partner and options in ../components/partner.ts (re-exported here).
 */

import { ChangeDetectionStrategy, Component, DestroyRef, Injector, computed, effect, inject, input, signal } from "@angular/core";
import { Bell, CircleHelp, History, House, Loader2, LogOut, UserRound, Wallet, type LucideIconData } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { PushPrompt } from "../../shared/chrome/push-prompt";
import { RegionButton } from "../../shared/chrome/region-picker";
import { Logo } from "../../shared/shop/shop-chrome";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Toast } from "../../shared/ui/ui";
import { DeliveryFeedService, OfferPopup, unlockAudio } from "../components/feed";
import { PartnerService } from "../components/partner";

/* ---------------------------------------------------------------- partner, options and feed (in ../components) */

export { DeliveryFeedService, unlockAudio } from "../components/feed";
export { PartnerService, deliveryOptions, loadDeliveryOptions, type PartnerStatus } from "../components/partner";

/* ---------------------------------------------------------------- loaders and notices */

@Component({
  selector: "pc-full-loader",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex min-h-[60vh] flex-col items-center justify-center gap-3 text-ink-soft", role: "status" },
  template: `<svg [pcIcon]="Loader2" class="h-8 w-8 animate-spin text-peacock" /><span class="text-sm">{{ label() }}…</span>`,
})
export class FullLoader {
  readonly label = input("Loading");
  protected readonly Loader2 = Loader2;
}

/** Shown on the home screen when the account is switched off, or deliveries are paused for everyone. */
@Component({
  selector: "pc-no-requests-notice",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block rounded-3xl bg-vermilion-light p-5 text-center ring-1 ring-vermilion/20", role: "status", "data-testid": "no-requests" },
  template: `
    <p class="font-display text-xl font-semibold text-vermilion">{{ inactive() ? "Your account is switched off" : "Deliveries are paused" }}</p>
    <p class="mt-1 text-ink-soft">
      {{ inactive() ? "You will not get new delivery requests." : "The delivery team has paused new requests for now." }}{{ carrying() ? " Finish the packages you have: deliver them, or bring them back to the store." : "" }}
    </p>
    @if (inactive()) {<a pcLink="/delivery/help" class="mt-3 inline-block rounded-full bg-white px-5 py-2 font-semibold text-vermilion ring-1 ring-vermilion/30">Contact the delivery team</a>}
  `,
})
export class NoRequestsNotice {
  readonly inactive = input(false);
  readonly carrying = input(false);
}

/* ---------------------------------------------------------------- frames */

function signOutTo(session: SessionService) {
  return () => void session.signOut().then(() => window.location.assign(new URL("/delivery/login", window.location.origin)));
}

/** Registration and other screens before approval: brand bar, no tabs. */
@Component({
  selector: "pc-simple-frame",
  imports: [Icon, PcLink, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen bg-mist" },
  template: `
    <header class="bg-peacock text-white">
      <div class="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
        <a pcLogo></a>
        <span class="whitespace-nowrap rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Partner</span>
        <div class="ml-auto flex items-center gap-1">
          <a pcLink="/delivery/help" aria-label="Help" class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold hover:bg-white/10">
            <svg [pcIcon]="CircleHelp" class="h-4 w-4 shrink-0" /> <span class="hidden sm:inline">Help</span>
          </a>
          <button type="button" (click)="signOut()" class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold hover:bg-white/10" aria-label="Sign out">
            <svg [pcIcon]="LogOut" class="h-4 w-4 shrink-0" /> <span class="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
    <div class="awning bg-mist" aria-hidden="true"></div>
    <main class="mx-auto max-w-3xl px-4 pb-16 pt-2"><ng-content /></main>
  `,
})
export class SimpleFrame {
  protected readonly signOut = signOutTo(inject(SessionService));
  protected readonly CircleHelp = CircleHelp;
  protected readonly LogOut = LogOut;
}

/* ---------------------------------------------------------------- online switch */

@Component({
  selector: "pc-online-switch",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (partner.partner(); as p) {
      @if (p.is_active !== false) {
        <button type="button" role="switch" [attr.aria-checked]="p.is_online" (click)="flip()" [disabled]="busy()" data-testid="online-switch" [class]="cls()">
          <span class="flex items-center gap-2">
            <span [class]="p.is_online ? 'relative flex h-2.5 w-2.5' : 'relative flex h-2.5 w-2.5 opacity-60'">
              @if (p.is_online) {<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80 motion-reduce:animate-none"></span>}
              <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-white"></span>
            </span>
            {{ p.is_online ? "Online" : "Offline" }}
          </span>
          <span [class]="knobCls()">
            @if (busy()) {<svg [pcIcon]="Loader2" class="h-4 w-4 animate-spin" />} @else {<span class="text-[11px] font-black">{{ p.is_online ? "ON" : "OFF" }}</span>}
          </span>
        </button>
      }
    }
  `,
})
export class OnlineSwitch {
  readonly large = input(false);
  protected readonly partner = inject(PartnerService);
  private readonly feed = inject(DeliveryFeedService);
  private readonly toast = inject(Toast);
  protected readonly busy = signal(false);
  protected readonly Loader2 = Loader2;
  private readonly on = computed(() => Boolean(this.partner.partner()?.is_online));
  protected readonly cls = computed(() => cx("relative flex items-center gap-2 rounded-full font-bold transition-colors disabled:opacity-70",
    this.large() ? "h-14 w-full justify-between px-2 pl-5 text-lg" : "h-10 pl-3 pr-1 text-sm",
    this.on() ? "bg-leaf text-white shadow-[0_0_0_4px_rgba(30,142,62,0.25)]" : "bg-white/15 text-white ring-1 ring-white/40",
    this.large() && !this.on() && "bg-ink/80"));
  protected readonly knobCls = computed(() => cx("flex items-center justify-center rounded-full bg-white transition-transform", this.large() ? "h-10 w-10" : "h-8 w-8", this.on() ? "text-leaf" : "text-ink-soft"));

  protected async flip(): Promise<void> {
    const partner = this.partner.partner();
    if (!partner) return;
    this.busy.set(true);
    unlockAudio();
    try {
      const r = await api<{ is_online: boolean }>("/api/delivery/me/online", { method: "POST", body: { online: !partner.is_online } });
      this.partner.set({ ...partner, is_online: r.is_online });
      this.feed.refresh();
      this.toast.show(r.is_online ? "You are online. New delivery requests will pop up here." : "You are offline. You will not get new requests.");
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not change your status", "error");
    } finally {
      this.busy.set(false);
    }
  }
}

const TABS: { href: string; label: string; icon: LucideIconData }[] = [
  { href: "/delivery", label: "Home", icon: House },
  { href: "/delivery/earnings", label: "Earnings", icon: Wallet },
  { href: "/delivery/history", label: "History", icon: History },
  { href: "/delivery/profile", label: "Profile", icon: UserRound },
];

/**
 * The approved partner's app: top bar with the online switch, tabs at the bottom (phones) or on the side. New delivery
 * requests pop up over whichever screen is open (OfferPopup). The feed polls and shares the location while it is on screen.
 */
@Component({
  selector: "pc-delivery-shell",
  imports: [Icon, PcLink, Logo, RegionButton, OnlineSwitch, PushPrompt, OfferPopup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen bg-mist pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-10" },
  template: `
    <header class="sticky top-0 z-30 bg-peacock text-white shadow-[0_2px_12px_rgba(0,0,0,0.12)]">
      <div class="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:px-4">
        <a pcLogo></a>
        <span class="hidden rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold sm:inline">Partner</span>
        <div class="ml-auto flex items-center gap-1.5">
          <!-- the home screen has its own big switch on phones -->
          <span [attr.class]="path() === '/delivery' ? 'hidden lg:block' : null"><pc-online-switch /></span>
          <pc-region-button [languageOnly]="true" tone="dark" buttonClass="h-10" />
          <a pcLink="/delivery/notifications" [attr.aria-label]="'Notifications, ' + unread() + ' unread'" class="relative flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10">
            <svg [pcIcon]="Bell" class="h-5 w-5" />
            @if (unread() > 0) {<span class="absolute right-1 top-1 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px]">{{ unread() > 9 ? "9+" : unread() }}</span>}
          </a>
        </div>
      </div>
    </header>
    <div class="mx-auto flex max-w-6xl gap-6 px-3 pt-4 sm:px-4">
      <nav class="sticky top-[72px] hidden h-fit w-56 shrink-0 flex-col gap-1 rounded-2xl bg-white p-2 shadow-sm lg:flex" aria-label="Partner app">
        @for (t of tabs; track t.href) {
          <a [pcLink]="t.href" [attr.aria-current]="active(t.href) ? 'page' : null"
            [class]="active(t.href) ? 'flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold transition-colors bg-peacock text-white' : 'flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold transition-colors text-ink hover:bg-peacock-light hover:text-peacock'">
            <svg [pcIcon]="t.icon" class="h-5 w-5" /> {{ t.label }}</a>
        }
        <a pcLink="/delivery/help" [class]="active('/delivery/help') ? 'flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold bg-peacock text-white' : 'flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold text-ink hover:bg-peacock-light'">
          <svg [pcIcon]="CircleHelp" class="h-5 w-5" /> Help</a>
        <button type="button" (click)="signOut()" class="mt-2 flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold text-ink-soft hover:bg-mist" aria-label="Sign out">
          <svg [pcIcon]="LogOut" class="h-4 w-4 shrink-0" /> <span>Sign out</span>
        </button>
      </nav>
      <main class="flex min-w-0 flex-1 flex-col gap-4">
        @if (path() === "/delivery") {
          <pc-push-prompt app="delivery" [showBlocked]="true" [title]="'Get delivery requests even when the app is closed'"
            [text]="'Turn on notifications so a new request rings your phone. You can still only accept from the app.'" />
        }
        <div><ng-content /></div>
      </main>
    </div>
    <nav class="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur lg:hidden" aria-label="Partner app">
      <div class="mx-auto grid max-w-md grid-cols-4">
        @for (t of tabs; track t.href) {
          <a [pcLink]="t.href" [attr.aria-current]="active(t.href) ? 'page' : null" class="flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold">
            <span [class]="active(t.href) ? 'flex h-8 w-14 items-center justify-center rounded-full transition-colors bg-peacock-light text-peacock' : 'flex h-8 w-14 items-center justify-center rounded-full transition-colors text-ink-soft'">
              <svg [pcIcon]="t.icon" class="h-5 w-5" />
            </span>
            <span [class]="active(t.href) ? 'text-peacock' : 'text-ink-soft'">{{ t.label }}</span>
          </a>
        }
      </div>
    </nav>
    <pc-offer-popup />
  `,
})
export class DeliveryShell {
  protected readonly path = inject(RouteState).pathname;
  protected readonly signOut = signOutTo(inject(SessionService));
  protected readonly unread = signal(0);
  protected readonly tabs = TABS;
  protected readonly Bell = Bell;
  protected readonly CircleHelp = CircleHelp;
  protected readonly LogOut = LogOut;
  protected active(href: string): boolean {
    return href === "/delivery" ? this.path() === "/delivery" : this.path().startsWith(href);
  }
  constructor() {
    inject(DeliveryFeedService).connect(inject(Injector));
    effect(() => {
      this.path();
      api<{ unread: number }>("/api/notifications").then((r) => this.unread.set(r.unread)).catch(() => {});
    });
    // sound for new requests needs one tap on the page first (a browser rule)
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    });
  }
}
