"use client";

import { FreshFooter } from "@/themes/fresh/footer";
import { FreshHeader } from "@/themes/fresh/header";
import { FreshMobileNav } from "@/themes/fresh/mobile-nav";
import { FreshProductTile } from "@/themes/fresh/product-tile";
import type { ThemeSlots } from "@/themes/types";

/** Fresh (quick commerce): its own header, footer, phone tab bar with a floating cart pill, and ADD-button tiles. */
export const freshSlots: ThemeSlots = {
  Header: FreshHeader,
  Footer: FreshFooter,
  MobileNav: FreshMobileNav,
  ProductTile: FreshProductTile,
};
