"use client";

import { useSite } from "@/lib/site";

/** The full-width "Back to top" bar above the footer (Admin → Storefront → Navigation can switch it off). */
export function BackToTop() {
  const site = useSite();
  if (site.home_extras?.back_to_top === false) return null;
  return (
    <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} data-testid="back-to-top"
      className="mt-6 block w-full bg-peacock-dark/90 py-3.5 text-center text-sm font-semibold text-white hover:bg-peacock-dark">
      Back to top
    </button>
  );
}
