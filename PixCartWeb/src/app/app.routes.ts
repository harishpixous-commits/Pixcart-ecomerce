/*
 * Every reference address (frontend/src/app/...), area by area. Each area loads lazily inside its frame:
 *   /admin/**     the admin layout (sidebar, top navigation, rail or glass shell)    → admin/admin.routes.ts
 *   /seller/**    the seller hub (portal shell)                                       → seller/seller.routes.ts
 *   /delivery/**  the delivery partner app (its own shell; login, join, download bare) → delivery/delivery.routes.ts
 *   everything else: the shop, inside the active storefront theme                     → shop/shop.routes.ts
 * /theme-preview sets or clears the theme preview cookie and redirects.
 */

import type { Routes } from "@angular/router";
import { ShopFrame } from "./themes/shop-frame";
import { themePreviewGuard } from "./themes/theme-preview";

export const routes: Routes = [
  { path: "theme-preview", canActivate: [themePreviewGuard], children: [] },
  {
    path: "admin",
    loadComponent: () => import("./admin/admin-layout").then((m) => m.AdminLayout),
    loadChildren: () => import("./admin/admin.routes").then((m) => m.ADMIN_ROUTES),
  },
  {
    path: "seller",
    loadComponent: () => import("./seller/seller-layout").then((m) => m.SellerLayout),
    loadChildren: () => import("./seller/seller.routes").then((m) => m.SELLER_ROUTES),
  },
  {
    path: "delivery",
    loadComponent: () => import("./delivery/delivery-layout").then((m) => m.DeliveryLayout),
    loadChildren: () => import("./delivery/delivery.routes").then((m) => m.DELIVERY_ROUTES),
  },
  {
    path: "",
    component: ShopFrame,
    loadChildren: () => import("./shop/shop.routes").then((m) => m.SHOP_ROUTES),
  },
];
