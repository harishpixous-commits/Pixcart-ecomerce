"use client";

/*
 * The delivery partner app frame: who the partner is (context), which screen they may see (sign-in, registration,
 * approved), and the mobile-first shell with the online switch, a bottom tab bar on phones and a side menu on
 * larger screens. Works the same in a phone browser, installed to the home screen and inside the Android app.
 */

import clsx from "clsx";
import { Bell, HelpCircle, History, Home, LogOut, Loader2, UserRound, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/shop-chrome";
import { useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { DeliveryOptions, Partner } from "@/lib/delivery-types";
import { useSession } from "@/lib/session";

/* ---------------------------------------------------------------- options (cached for the visit) */

let optionsCache: Promise<DeliveryOptions> | null = null;

export function loadDeliveryOptions(): Promise<DeliveryOptions> {
  if (!optionsCache) optionsCache = api<DeliveryOptions>("/api/delivery/options").catch((e) => { optionsCache = null; throw e; });
  return optionsCache;
}

export function useDeliveryOptions(): DeliveryOptions | null {
  const [o, setO] = useState<DeliveryOptions | null>(null);
  useEffect(() => {
    let live = true;
    loadDeliveryOptions().then((x) => { if (live) setO(x); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return o;
}

/* ---------------------------------------------------------------- the signed-in partner */

type PartnerState = { partner: Partner | null; status: "loading" | "none" | "ready" | "error"; reload: () => Promise<void>; set: (p: Partner) => void };
const PartnerCtx = createContext<PartnerState>({ partner: null, status: "loading", reload: async () => {}, set: () => {} });

export function usePartner() {
  return useContext(PartnerCtx);
}

function PartnerProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<{ partner: Partner | null; status: PartnerState["status"] }>({ partner: null, status: "loading" });
  const reload = useCallback(
    () => api<Partner>("/api/delivery/me")
      .then((p) => setData({ partner: p, status: "ready" }))
      .catch((e) => setData({ partner: null, status: e instanceof ApiError && e.code === "not_registered" ? "none" : "error" })),
    [],
  );
  useEffect(() => { reload(); }, [reload]);
  const value = useMemo(() => ({ ...data, reload, set: (p: Partner) => setData({ partner: p, status: "ready" }) }), [data, reload]);
  return <PartnerCtx.Provider value={value}>{children}</PartnerCtx.Provider>;
}

/* ---------------------------------------------------------------- gate */

const PUBLIC = ["/delivery/join", "/delivery/login", "/delivery/download"];
const BEFORE_APPROVAL = ["/delivery/register", "/delivery/help", "/delivery/notifications"];

export function FullLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-ink-soft" role="status">
      <Loader2 className="h-8 w-8 animate-spin text-peacock" aria-hidden />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function DeliveryApp({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, ready } = useSession();
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  useEffect(() => {
    if (!isPublic && ready && !user) router.replace(`/delivery/login?next=${encodeURIComponent(pathname)}`);
  }, [isPublic, ready, user, pathname, router]);
  if (isPublic) return <>{children}</>;
  if (!ready || !user) return <FullLoader />;
  return (
    <PartnerProvider key={user.id}>
      <Gate>{children}</Gate>
    </PartnerProvider>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  const { partner, status } = usePartner();
  const pathname = usePathname();
  const router = useRouter();
  const approved = partner?.kyc_status === "approved";
  const allowedEarly = BEFORE_APPROVAL.some((p) => pathname.startsWith(p));
  useEffect(() => {
    if ((status === "none" || (status === "ready" && !approved)) && !allowedEarly) router.replace("/delivery/register");
    if (status === "ready" && approved && pathname.startsWith("/delivery/register")) router.replace("/delivery");
  }, [status, approved, allowedEarly, pathname, router]);
  if (status === "loading") return <FullLoader label="Opening your partner app" />;
  if (status === "error") return <ErrorScreen />;
  if (!approved) return <SimpleFrame>{allowedEarly ? children : <FullLoader />}</SimpleFrame>;
  if (partner?.is_active === false) return <SimpleFrame><Inactive /></SimpleFrame>;
  return <DeliveryShell>{children}</DeliveryShell>;
}

function ErrorScreen() {
  return (
    <SimpleFrame>
      <div className="mx-auto mt-10 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
        <p className="font-display text-xl font-semibold">Could not open the app</p>
        <p className="mt-1 text-ink-soft">Check your internet connection and try again.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-full bg-peacock px-5 py-2 font-semibold text-white">Try again</button>
      </div>
    </SimpleFrame>
  );
}

function Inactive() {
  return (
    <div className="mx-auto mt-10 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
      <p className="font-display text-xl font-semibold">Your account is switched off</p>
      <p className="mt-1 text-ink-soft">You cannot take deliveries right now. Contact the delivery team for help.</p>
      <Link href="/delivery/help" className="mt-4 inline-block rounded-full bg-peacock px-5 py-2 font-semibold text-white">Get help</Link>
    </div>
  );
}

/* ---------------------------------------------------------------- frames */

function SignOut({ className, short }: { className?: string; short?: boolean }) {
  const { signOut } = useSession();
  return (
    <button type="button" onClick={() => signOut().then(() => window.location.assign(new URL("/delivery/login", window.location.origin)))} className={className}
      aria-label="Sign out">
      <LogOut className="h-4 w-4 shrink-0" aria-hidden /> <span className={short ? "hidden sm:inline" : undefined}>Sign out</span>
    </button>
  );
}

/** Registration and other screens before approval: brand bar, no tabs. */
export function SimpleFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-mist">
      <header className="bg-peacock text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
          <Logo />
          <span className="whitespace-nowrap rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Partner</span>
          <div className="ml-auto flex items-center gap-1">
            <Link href="/delivery/help" aria-label="Help" className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold hover:bg-white/10">
              <HelpCircle className="h-4 w-4 shrink-0" aria-hidden /> <span className="hidden sm:inline">Help</span>
            </Link>
            <SignOut short className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold hover:bg-white/10" />
          </div>
        </div>
      </header>
      <div className="awning bg-mist" aria-hidden />
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-2">{children}</main>
    </div>
  );
}

const TABS = [
  { href: "/delivery", label: "Home", icon: Home },
  { href: "/delivery/earnings", label: "Earnings", icon: Wallet },
  { href: "/delivery/history", label: "History", icon: History },
  { href: "/delivery/profile", label: "Profile", icon: UserRound },
];

function useUnread() {
  const pathname = usePathname();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ unread: number }>("/api/notifications").then((r) => { if (live) setN(r.unread); }).catch(() => {});
    return () => { live = false; };
  }, [pathname]);
  return n;
}

/** The approved partner's app: top bar with the online switch, tabs at the bottom (phones) or on the side. */
export function DeliveryShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const unread = useUnread();
  const active = (href: string) => (href === "/delivery" ? pathname === "/delivery" : pathname.startsWith(href));
  return (
    <div className="min-h-screen bg-mist pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-10">
      <header className="sticky top-0 z-30 bg-peacock text-white shadow-[0_2px_12px_rgba(0,0,0,0.12)]">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:px-4">
          <Logo />
          <span className="hidden rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold sm:inline">Partner</span>
          <div className="ml-auto flex items-center gap-1.5">
            {/* the home screen has its own big switch on phones */}
            <span className={pathname === "/delivery" ? "hidden lg:block" : undefined}><OnlineSwitch /></span>
            <Link href="/delivery/notifications" aria-label={`Notifications, ${unread} unread`} className="relative flex h-10 w-10 items-center justify-center rounded-xl hover:bg-white/10">
              <Bell className="h-5 w-5" />
              {unread > 0 && <span className="absolute right-1 top-1 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px]">{unread > 9 ? "9+" : unread}</span>}
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-6 px-3 pt-4 sm:px-4">
        <nav className="sticky top-[72px] hidden h-fit w-56 shrink-0 flex-col gap-1 rounded-2xl bg-white p-2 shadow-sm lg:flex" aria-label="Partner app">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} aria-current={active(t.href) ? "page" : undefined}
              className={clsx("flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold transition-colors", active(t.href) ? "bg-peacock text-white" : "text-ink hover:bg-peacock-light hover:text-peacock")}>
              <t.icon className="h-5 w-5" aria-hidden /> {t.label}
            </Link>
          ))}
          <Link href="/delivery/help" className={clsx("flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold", active("/delivery/help") ? "bg-peacock text-white" : "text-ink hover:bg-peacock-light")}>
            <HelpCircle className="h-5 w-5" aria-hidden /> Help
          </Link>
          <SignOut className="mt-2 flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold text-ink-soft hover:bg-mist" />
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur lg:hidden" aria-label="Partner app">
        <div className="mx-auto grid max-w-md grid-cols-4">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} aria-current={active(t.href) ? "page" : undefined} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold">
              <span className={clsx("flex h-8 w-14 items-center justify-center rounded-full transition-colors", active(t.href) ? "bg-peacock-light text-peacock" : "text-ink-soft")}>
                <t.icon className="h-5 w-5" aria-hidden />
              </span>
              <span className={active(t.href) ? "text-peacock" : "text-ink-soft"}>{t.label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------------- online switch */

export function OnlineSwitch({ large }: { large?: boolean }) {
  const { partner, set } = usePartner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!partner) return null;
  const on = partner.is_online;
  async function flip() {
    if (!partner) return;
    setBusy(true);
    try {
      const r = await api<{ is_online: boolean }>("/api/delivery/me/online", { method: "POST", body: { online: !on } });
      set({ ...partner, is_online: r.is_online });
      toast(r.is_online ? "You are online. New delivery requests will pop up here." : "You are offline. You will not get new requests.");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not change your status", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" role="switch" aria-checked={on} onClick={flip} disabled={busy} data-testid="online-switch"
      className={clsx("relative flex items-center gap-2 rounded-full font-bold transition-colors disabled:opacity-70",
        large ? "h-14 w-full justify-between px-2 pl-5 text-lg" : "h-10 pl-3 pr-1 text-sm",
        on ? "bg-leaf text-white shadow-[0_0_0_4px_rgba(30,142,62,0.25)]" : "bg-white/15 text-white ring-1 ring-white/40",
        large && !on && "bg-ink/80")}>
      <span className="flex items-center gap-2">
        <span className={clsx("relative flex h-2.5 w-2.5", !on && "opacity-60")}>
          {on && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80 motion-reduce:animate-none" />}
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
        </span>
        {on ? "Online" : "Offline"}
      </span>
      <span className={clsx("flex items-center justify-center rounded-full bg-white transition-transform", large ? "h-10 w-10" : "h-8 w-8", on ? "text-leaf" : "text-ink-soft")}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="text-[11px] font-black">{on ? "ON" : "OFF"}</span>}
      </span>
    </button>
  );
}
