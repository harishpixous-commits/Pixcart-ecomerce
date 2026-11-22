"use client";

import { ProductPageSkeleton } from "@/components/skeletons";

/** While a product page loads: gallery, details and buy box in the theme's product page layout. */
export default function Loading() {
  return <ProductPageSkeleton />;
}
