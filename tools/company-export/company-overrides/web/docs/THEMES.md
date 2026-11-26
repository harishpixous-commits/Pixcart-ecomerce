# Themes, layouts, loaders and media

The storefront has switchable **themes**: each changes the whole shop for every visitor — colours, fonts, corner
shapes, shadows and the **layout** of every screen (header, navigation, home, product cards and grids, category and
search pages, product page, cart, sign-in, footer, phone tab bar). The admin panel has switchable **layouts** that each
staff member picks for themselves. Both are configuration, not code changes: owners switch, preview and customise
them in the admin panel.

## For the owner

**Admin → Storefront → Theme and layout**

1. Pick a theme from the gallery (each card is a live miniature of that theme).
2. Pick a colour preset, or "Brand colours" (the colours from the Brand tab), and change any of the six colours.
   The picker warns when text would be hard to read.
3. Change any layout option if you like (product grid, products per row, product page, filters, cart, sign-in,
   categories, sections, page width) — or leave the theme's own.
4. **Live preview** shows the real shop in that theme on a phone, tablet or desktop, on any page, before anything
   is saved. Only you see it.
5. **Apply** switches the shop at once. Every theme keeps its own preset, colours and layout, so you can switch back
   and forth without losing your choices. Classic (the original look) is always one click away.

You can also open `/theme-preview?theme=<id>` in a browser tab; a bar on top says you are previewing and has an
Exit button. Nothing is saved and shoppers keep seeing the live theme.

**Admin → My account → Appearance** (or the palette button in the admin header) changes your admin layout; the
owner sets the default for new staff in **Admin → Marketplace settings**.

**Admin → Storefront → Home page**: every image slot (hero slides, banners, banner grids, card tiles) also takes a
video, and the "Image or video block" adds a full picture or video anywhere on the home page. Upload images and
videos once in the media library and pick them anywhere.

## Storefront themes

| Theme | Feel | Header | Products | Product page | Best for |
|---|---|---|---|---|---|
| **Classic** | Indian bazaar, teal and marigold (the original look) | Search-first, awning edge, category bar | Hairline grid | Three columns: gallery, details, buy box | Every category |
| **Bazaar** | Bold big store | Two tiers, centred search, all-categories mega menu | Raised cards with discount ribbons | Two columns, sticky buy panel | Electronics, sales |
| **Fresh** | Quick commerce, app-like | White, location pill, big search, category strip | Small cards with an ADD button | Two columns, cart bar at the bottom | Groceries, daily needs |
| **Luxe** | Boutique, ivory, black and gold, serif | Centred logo, minimal menu, search panel | Tall borderless photos | Large photo gallery | Fashion, gifts, premium |

Each theme has five colour presets plus "Brand colours"; every preset passes 4.5:1 text contrast. Every theme
works on phones, tablets and desktops, keeps every feature of the shop (search, filters, deals, wishlist, compare,
cart, checkout, orders, returns, help) and shows the legally required grievance officer and business details.

## How it is built (`PixCartWeb/src/app/themes`)

```
src/app/themes/
  types.ts         the contract: tokens, layout options (+ LAYOUT_CHOICES, LayoutOverrides), presets, slots
  manifest.ts      every theme's data; resolveTheme(site, preview); presets; layout overrides; preview cookie
  css.ts           the CSS variables a theme sets (colours, ink, fonts, heading spacing, radius, shadows, width)
  context.ts       ThemeService: active(), layout() (with the owner's layout changes applied)
  slots.ts         every theme's components
  shop-frame.ts    the shop frame: preview bar, header, page, footer, phone tab bar, help, compare tray
  theme-preview.ts the /theme-preview page
  classic/ bazaar/ fresh/ luxe/
    theme.ts       tokens + layout options + colour presets (data only)
    chrome.ts      Header, Footer, MobileNav
    product-tile.ts ProductTile
```

- **Tokens** are CSS variables (`--c-primary`, `--c-ink`, `--c-line`, `--f-display`, `--r-xl`, `--shadow-card`,
  `--w-shop` ...). The utility colours (`peacock`, `marigold`, `vermilion`, `leaf`, `ink`, `mist`, `line`), fonts,
  radii, shadows and `max-w-shop` read them, so screens follow the theme without code changes. The brand colours
  are set on `:root` for the admin, seller hub, delivery pages and emails (`core/theme.ts`); `ThemeService` sets the
  theme's variables on `:root:root` only while a shop page is open.
- **Slots** are the parts whose structure differs: `Header`, `Footer`, `MobileNav`, `ProductTile`.
  `shared/product/product.ts` renders the active theme's tile; shared tile behaviour (deal badge, quick add, ad
  links, prices, delivery date) is in `shared/product/product-parts.ts`. Header parts (search box, All menu, account
  menu, cart, delivery PIN, footer data) are shared from `shared/shop/shop-chrome.ts` and `shared/shop/shop-nav.ts`
  with light and dark tones.
- **Layout options** (`theme.layout`, changed per theme by `theme_settings[<id>].layout`) let shared screens change
  arrangement without copying them: product grid style and columns (`pc-product-grid`, `pc-product-rail`), home
  categories and sections (`shop/home/home-sections.ts`), filters on the side or on top
  (`shop/browse/search-view.ts`), product page (`shop/browse/buy-box.ts`), cart summary, sign-in, page width.
- **Saved settings** (`PixCartAPI/BAL/SiteBAL.cs`): `site.theme` and `site.theme_settings` =
  `{ <id>: { preset, colors, layout } }`. `PUT /api/admin/storefront/theme` switches the theme and saves theme
  settings without touching other site settings. An unknown theme reads as Classic.
- **Preview**: `/theme-preview?theme=<id>&preset=<id>&primary=%23RRGGBB&layout=productGrid:cards&to=/path` sets a
  two-hour cookie (`pc_theme_preview`) for that browser; `?theme=off` clears it. The admin's live preview shows it in
  a same-site frame (frames from other sites are refused).
- Each theme is a **module**: its folder, one line in `manifest.ts` and `slots.ts`, its id in `types.ts` and in
  `SiteBAL.cs`. Themes never import each other (a theme may reuse Classic's parts). Removing or changing one theme
  cannot break another.

### Adding a theme

1. Copy `src/app/themes/classic` to `src/app/themes/<id>`; change `theme.ts` (tokens, layout, presets, `chrome`) and
   the slot components. Use only token classes (no hex colours) so presets and colour changes work.
2. Add it to `THEMES` in `manifest.ts`, the slots in `slots.ts`, `THEME_IDS` in `types.ts` and the theme list in
   `SiteBAL.cs`.
3. Check every screen at 390, 820 and 1440 px.

## Loaders and skeletons

No screen is ever blank: `<pc-page-loader>` shows skeletons in the shape of the content (in
the active theme's grid and layout), after a short delay so fast pages never flash; the top progress bar shows on
every navigation; buttons show their own spinner while working. Skeletons stop shimmering for visitors who ask for
reduced motion. Building blocks: `shared/ui/skeletons.ts` and `shared/ui/page-loader.ts`.

## Media in home blocks

`shared/chrome/media.ts` renders an image, or a video that plays muted on a loop only while on screen (the image is
its poster and stays still for visitors who ask for reduced motion; blocks that play a video have a pause button).
Hero slides, banners, banner grids and card tiles take an optional `video`; the "Image or video block" (`media`
section) has its own heading, text, button, link, shape (21:9 to 4:5), width and tone. Videos come from the media
library (mp4 or webm, up to the video size limit in Marketplace settings).

## Admin layouts (`src/app/shared/admin-shell`)

| Layout | For |
|---|---|
| **Sidebar** (default) | The full menu on the left with collapsible sections, quick find (Ctrl+K), collapse to icons |
| **Top navigation** | The menu as grouped drop-downs across the top; full-width pages |
| **Compact rail** | A slim dark icon rail that opens on hover or tap; the most room for tables |
| **Glass** | Inspired by Apple's design guidelines: a frosted sidebar and toolbar, large page titles, grouped sections, the system font; a tab bar with More on phones |

Every layout shows the same menu (filtered by the staff member's role), badges, notifications, the AI assistant and
sign-out. The choice is stored per staff member (`users.ui_prefs`, `GET/PUT /api/admin/me/preferences`); the
owner's default is `admin_layout_default` in Marketplace settings.
