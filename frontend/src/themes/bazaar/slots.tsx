"use client";

import { BazaarFooter } from "@/themes/bazaar/footer";
import { BazaarHeader } from "@/themes/bazaar/header";
import { BazaarMobileNav } from "@/themes/bazaar/mobile-nav";
import { BazaarProductTile } from "@/themes/bazaar/product-tile";
import type { ThemeSlots } from "@/themes/types";

export const bazaarSlots: ThemeSlots = {
  Header: BazaarHeader,
  Footer: BazaarFooter,
  MobileNav: BazaarMobileNav,
  ProductTile: BazaarProductTile,
};
