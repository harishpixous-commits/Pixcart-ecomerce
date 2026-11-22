"use client";

import { MobileTabBar, ShopFooter, ShopHeader } from "@/components/shop-chrome";
import { ClassicProductTile } from "@/themes/classic/product-tile";
import type { ThemeSlots } from "@/themes/types";

export const classicSlots: ThemeSlots = {
  Header: ShopHeader,
  Footer: ShopFooter,
  MobileNav: MobileTabBar,
  ProductTile: ClassicProductTile,
};
