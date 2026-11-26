# PixCartWeb (Angular 21)

The PixCart storefront (four themes), seller hub, delivery partner pages and admin panel.

## Run

```bash
npx -y npm@11 install
npx ng serve            # http://localhost:4201, /api and /media proxied to the API (proxy.conf.json)
npx ng build
npm run test:shop-contracts
```

## Where things are

| Path | What |
|---|---|
| `src/app/core/` | `api.ts` (fetch client, token in memory, single-flight refresh, `ApiError`, `quietly`, `latestOnly`, uploads), `session.ts` (`SessionService`), `site.ts` (`SiteService`), `regional.ts`, `i18n.ts`, `format.ts`, `tokens.ts`, `types.ts`, `route-state.ts` (`RouteState`: current path and query), `wishlist.ts`, `pincode.ts`, `admin.ts` (`AdminContext`), `primeng-pt.ts`, ... |
| `src/app/themes/` | theme engine (`manifest.ts`, `css.ts`, `context.ts` = `ThemeService`), the four themes' header/footer/tab bar/tile, `slots.ts`, `shop-frame.ts`, `theme-preview.ts` |
| `src/app/shared/ui/` | `ui.ts` (Button, ButtonLink, Field, Input, TextField, Select, Textarea, Spinner, Price, Rating, Pill, StatusPill, EmptyState, ErrorNote, Pagination, Modal, Toast, ProductImage), `skeletons.ts`, `page-loader.ts`, `icon.ts`, `link.ts`, `cx.ts` |
| `src/app/shared/chrome/` | back button, route progress, app banner, region picker, pay logos, error pages, social, category icon, compare, markdown, media |
| `src/app/shared/shop/` | shop header parts (logo, account menu, deliver-to, cart link, search box, All menu, nav bar) |
| `src/app/shared/product/` | product tile parts, theme tile outlet, grid frame, product grid and rail |
| `src/app/shared/admin-shell/`, `shared/portal-shell.ts`, `delivery/shell/` | panel shells |
| `src/app/<area>/<area>.routes.ts` | every URL of the area; the pages are in `src/app/<area>/pages/` |

## Adding or changing a page

1. Find the page: `/orders/:id` is `src/app/shop/pages/orders-id.page.ts` (`ShopOrdersIdPage`); the route map is
   `src/app/shop/shop.routes.ts`. Keep the class name, so the routes need no change.
2. Building blocks:
   - links → `<a pcLink="/path?x=1">`; navigation → `inject(Router).navigateByUrl(x)` (`{ replaceUrl: true }` to replace)
   - current path and query → `inject(RouteState).pathname()` / `.param("q")`; route params also arrive as component inputs
   - signed-in user and cart → `inject(SessionService)` (signals `user()`, `ready()`, `cartCount()`; `signIn`, `signOut`, `addToCart`)
   - site settings and lists → `inject(SiteService).site()` / `.lists()`; theme → `inject(ThemeService).layout()` / `.active()`
   - messages → `inject(Toast).show(text, "error")`; admin permissions → `inject(AdminContext).me()` / `.can(p)`
   - icons → `<svg [pcIcon]="Truck" class="h-5 w-5" />` (import from `lucide-angular`)
   - class lists → `cx(...)`; conditions → `@if`; lists → `@for (...; track id)`
   - loading states → `<pc-page-loader variant="list" />`; skeletons → `shared/ui/skeletons.ts`
   - product lists → `<pc-product-grid [items]>`, `<pc-product-rail title [items] href>`, or `<pc-grid-frame>` + `<ng-container [pcProductTile]="p" />`
   - seller/admin pages → `<pc-page-header title sub [back]>` (actions marked `actions`), `<pc-tabs>`, `<pc-stat>`, `<pc-table [head]>`
3. Hosts: a component's host element sits in the DOM. Use `host: { class: "contents" }` when the layout needs no
   element there, or make the host the root element (its classes in `host`). CSS child selectors (`[&>*]`,
   `space-y-*`, `divide-y`, `first:`) see the real DOM.
4. Keep the `data-testid`s: the screen tests use them.
