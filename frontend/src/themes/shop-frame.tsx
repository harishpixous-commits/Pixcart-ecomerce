"use client";

/*
 * The shop's frame in the active theme: its header, the page, its footer and phone tab bar, plus the shared extras
 * (back to top, help assistant, compare tray) and, while an admin previews a theme, the preview bar.
 */

import { Construction, Eye, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { AppBanner } from "@/components/app-banner";
import { ShopBackBar } from "@/components/back-button";
import { BackToTop } from "@/components/back-to-top";
import { CompareTray } from "@/components/compare";
import { ShopAssistant } from "@/components/shop-assistant/widget";
import { Logo } from "@/components/shop-chrome";
import { ShopRouteSkeleton } from "@/components/skeletons";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { BRAND_PRESET, findPreset } from "@/themes/manifest";
import { useTheme } from "@/themes/context";
import { useSlots } from "@/themes/slots";

const noSubscribe = () => () => {};

/** True inside the admin's live preview window (an iframe), where the admin page has its own controls. */
function useFramed() {
  return useSyncExternalStore(noSubscribe, () => window.self !== window.top, () => false);
}

function PreviewBar() {
  const t = useTheme();
  const pathname = usePathname();
  const framed = useFramed();
  if (framed) return null;
  const preset = t.presetId === BRAND_PRESET ? "brand colours" : findPreset(t.data, t.presetId)?.name ?? "";
  return (
    <div className="relative z-[35] bg-ink text-white" role="status" data-testid="theme-preview-bar">
      <div className="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-2 text-[13px] sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:text-sm">
        <p className="flex min-w-0 flex-1 items-center gap-2">
          <Eye className="h-4 w-4 shrink-0 text-marigold" aria-hidden />
          <span className="min-w-0">
            Previewing <b>{t.data.name}</b>{preset ? <> · {preset}</> : null}<span className="hidden md:inline">. Only you see this; shoppers see the live theme.</span>
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/admin/storefront?tab=theme" className="rounded-md bg-white/15 px-2.5 py-1 font-semibold hover:bg-white/25">Theme settings</Link>
          <a href={`/theme-preview?theme=off&to=${encodeURIComponent(pathname)}`} className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-white/10" data-testid="theme-preview-exit">
            <X className="h-4 w-4" /> Exit preview
          </a>
        </div>
      </div>
    </div>
  );
}

/** Pages that stay open during maintenance: signing in (so staff can get in), and the legal and contact pages. */
const OPEN_DURING_MAINTENANCE = ["/login", "/signup", "/pages", "/contact"];

/** What shoppers see while the owner has switched on maintenance mode (Admin → Marketplace settings). */
function MaintenancePage({ message }: { message: string }) {
  const site = useSite();
  return (
    <div className="flex min-h-screen flex-col bg-mist" data-testid="maintenance-page">
      <header className="bg-peacock px-4 py-4"><div className="mx-auto max-w-shop"><Logo /></div></header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg rounded-2xl bg-white p-8 text-center shadow-card">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-marigold-light text-ink">
            <Construction className="h-7 w-7" aria-hidden />
          </span>
          <h1 className="font-display text-2xl font-bold text-ink">We&apos;ll be back soon</h1>
          <p className="mt-3 text-ink-soft">{message}</p>
          <p className="mt-6 text-sm text-ink-soft">
            Need help with an order? <Link href="/contact" className="font-semibold text-peacock">Contact {site.brand_name}</Link>
          </p>
        </div>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-ink-faint">
        <Link href="/login" className="hover:underline">Staff sign in</Link>
      </footer>
    </div>
  );
}

/** Staff still use the shop during maintenance; this bar reminds them shoppers cannot. */
function MaintenanceBar() {
  return (
    <div className="relative z-[35] bg-marigold text-ink" role="status" data-testid="maintenance-bar">
      <div className="mx-auto flex max-w-shop flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] sm:px-4 sm:text-sm">
        <Construction className="h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1"><b>Maintenance mode is on.</b> Shoppers see the &ldquo;back soon&rdquo; page and cannot order; you see the shop as staff.</p>
        <Link href="/admin/settings#maintenance" className="rounded-md bg-ink/10 px-2.5 py-1 font-semibold hover:bg-ink/20">Turn it off</Link>
      </div>
    </div>
  );
}

export function ShopFrame({ children }: { children: React.ReactNode }) {
  const site = useSite();
  const { user, ready } = useSession();
  const pathname = usePathname();
  const closed = Boolean(site.maintenance?.on) && !OPEN_DURING_MAINTENANCE.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (closed && !ready) return <div className="mx-auto w-full max-w-shop px-3 py-6"><ShopRouteSkeleton /></div>;
  if (closed && !user?.is_admin) return <MaintenancePage message={site.maintenance?.message ?? ""} />;
  return <OpenShop maintenance={Boolean(site.maintenance?.on && user?.is_admin)}>{children}</OpenShop>;
}

function OpenShop({ maintenance, children }: { maintenance: boolean; children: React.ReactNode }) {
  const t = useTheme();
  const { Header, Footer, MobileNav } = useSlots();
  const layout = t.data.layout;
  return (
    <div data-theme={t.data.id} data-sections={layout.home.sections} data-grid={layout.productGrid} className="flex min-h-screen flex-col">
      {maintenance && <MaintenanceBar />}
      <AppBanner />
      {t.preview && <PreviewBar />}
      <Header />
      <ShopBackBar />
      <main className="mx-auto w-full min-h-[60vh] max-w-shop flex-1 px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      <BackToTop />
      <Footer />
      {MobileNav && <MobileNav />}
      <ShopAssistant />
      <CompareTray />
    </div>
  );
}
