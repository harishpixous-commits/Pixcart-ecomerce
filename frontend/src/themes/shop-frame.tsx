"use client";

/*
 * The shop's frame in the active theme: its header, the page, its footer and phone tab bar, plus the shared extras
 * (back to top, help assistant, compare tray) and, while an admin previews a theme, the preview bar.
 */

import { Eye, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { BackToTop } from "@/components/back-to-top";
import { CompareTray } from "@/components/compare";
import { ShopAssistant } from "@/components/shop-assistant/widget";
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
    <div className="sticky top-0 z-[35] bg-ink text-white" role="status" data-testid="theme-preview-bar">
      <div className="mx-auto flex max-w-shop flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:px-4">
        <Eye className="h-4 w-4 shrink-0 text-marigold" aria-hidden />
        <p className="min-w-0 flex-1">
          Previewing <b>{t.data.name}</b>{preset ? <> with {preset}</> : null}. Only you see this; shoppers see the live theme.
        </p>
        <Link href="/admin/storefront?tab=theme" className="rounded-md bg-white/15 px-2.5 py-1 font-semibold hover:bg-white/25">Back to theme settings</Link>
        <a href={`/theme-preview?theme=off&to=${encodeURIComponent(pathname)}`} className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-white/10" data-testid="theme-preview-exit">
          <X className="h-4 w-4" /> Exit preview
        </a>
      </div>
    </div>
  );
}

export function ShopFrame({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const { Header, Footer, MobileNav } = useSlots();
  const layout = t.data.layout;
  return (
    <div data-theme={t.data.id} data-sections={layout.home.sections} data-grid={layout.productGrid} className="flex min-h-screen flex-col">
      {t.preview && <PreviewBar />}
      <Header />
      <main className="mx-auto w-full min-h-[60vh] max-w-shop flex-1 px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      <BackToTop />
      <Footer />
      {MobileNav && <MobileNav />}
      <ShopAssistant />
      <CompareTray />
    </div>
  );
}
