"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSite } from "@/lib/site";

/*
 * A thin bar at the top of the window while the next page loads (Admin → Product page → "Page loading bar").
 * It starts when a link to another page is clicked and finishes when the new address is shown; the
 * loading.tsx skeletons fill the page itself meanwhile.
 */
export function RouteProgress() {
  const site = useSite();
  const pathname = usePathname();
  const search = useSearchParams();
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const safety = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const enabled = site.pdp?.page_loading_bar !== false;

  useEffect(() => {
    if (!enabled) return;
    const start = () => {
      clearInterval(timer.current);
      clearTimeout(safety.current);
      setVisible(true);
      setWidth(12);
      timer.current = setInterval(() => setWidth((w) => (w < 90 ? w + (90 - w) * 0.12 : w)), 200);
      safety.current = setTimeout(() => finish(), 12000);
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      start();
    };
    const onStart = () => start();
    document.addEventListener("click", onClick, true);
    window.addEventListener("route-progress:start", onStart);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("route-progress:start", onStart);
    };
  }, [enabled]);

  function finish() {
    clearInterval(timer.current);
    clearTimeout(safety.current);
    setWidth(100);
    setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 250);
  }

  // The new page is on screen.
  useEffect(() => {
    if (visible) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search]);

  if (!enabled || !visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]" role="progressbar" aria-label="Loading page" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(width)}>
      <div className="h-full bg-marigold shadow-[0_0_8px_rgba(245,165,36,0.8)] transition-[width] duration-200 ease-out" style={{ width: `${width}%` }} />
    </div>
  );
}
