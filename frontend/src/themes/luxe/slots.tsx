"use client";

import { LuxeFooter } from "@/themes/luxe/footer";
import { LuxeHeader } from "@/themes/luxe/header";
import { LuxeMobileNav } from "@/themes/luxe/mobile-nav";
import { LuxeProductTile } from "@/themes/luxe/product-tile";
import type { ThemeSlots } from "@/themes/types";

export const luxeSlots: ThemeSlots = {
  Header: LuxeHeader,
  Footer: LuxeFooter,
  MobileNav: LuxeMobileNav,
  ProductTile: LuxeProductTile,
};
