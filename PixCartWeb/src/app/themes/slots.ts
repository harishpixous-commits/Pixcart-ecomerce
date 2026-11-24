/*
 * Every theme's components (header, footer, phone tab bar, product tile), chosen at runtime from the active theme
 * (Admin → Storefront → Theme and layout, or the preview cookie). Port of themes/slots.tsx and themes/<id>/slots.tsx.
 * The shop frame renders Header/Footer/MobileNav with ngComponentOutlet; product lists use ProductTileOutlet.
 */

import type { Type } from "@angular/core";
import { BazaarFooter } from "./bazaar/footer";
import { BazaarHeader } from "./bazaar/header";
import { BazaarMobileNav } from "./bazaar/mobile-nav";
import { BazaarProductTile } from "./bazaar/product-tile";
import { ClassicFooter, ClassicHeader, ClassicMobileNav } from "./classic/chrome";
import { ClassicProductTile } from "./classic/product-tile";
import { FreshFooter } from "./fresh/footer";
import { FreshHeader } from "./fresh/header";
import { FreshMobileNav } from "./fresh/mobile-nav";
import { FreshProductTile } from "./fresh/product-tile";
import { LuxeFooter } from "./luxe/footer";
import { LuxeHeader } from "./luxe/header";
import { LuxeMobileNav } from "./luxe/mobile-nav";
import { LuxeProductTile } from "./luxe/product-tile";
import type { ThemeId } from "./types";

export interface ThemeSlotTypes {
  /** everything above the page content: announcement, header, navigation */
  Header: Type<unknown>;
  Footer: Type<unknown>;
  /** the phone tab bar (null: none) */
  MobileNav: Type<unknown> | null;
  /** inputs: p (ProductCard), showAdd, rank, quickPlus */
  ProductTile: Type<unknown>;
}

export const SLOTS: Record<ThemeId, ThemeSlotTypes> = {
  classic: { Header: ClassicHeader, Footer: ClassicFooter, MobileNav: ClassicMobileNav, ProductTile: ClassicProductTile },
  bazaar: { Header: BazaarHeader, Footer: BazaarFooter, MobileNav: BazaarMobileNav, ProductTile: BazaarProductTile },
  fresh: { Header: FreshHeader, Footer: FreshFooter, MobileNav: FreshMobileNav, ProductTile: FreshProductTile },
  luxe: { Header: LuxeHeader, Footer: LuxeFooter, MobileNav: LuxeMobileNav, ProductTile: LuxeProductTile },
};
