"use client";

import { ShopRouteSkeleton } from "@/components/skeletons";

/** While a shop page loads: the skeleton of that page (home, product, listing, cart...) in the active theme. */
export default function Loading() {
  return <ShopRouteSkeleton />;
}
