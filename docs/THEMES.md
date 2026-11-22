# Themes and layouts

The storefront and the admin panel each have switchable **themes**. A storefront theme changes the whole shop for
every visitor: colours, fonts, corner shapes, shadows, and the **layout** of every screen (header, navigation, home,
product cards and grids, category and search pages, product page, cart and checkout, sign-in, footer, the phone tab
bar). An admin layout changes how staff move around the admin panel (sidebar, top navigation or a compact rail); each
staff member picks their own, and the owner sets the default.

Owners switch the storefront theme in **Admin → Storefront → Theme and layout** (with a live preview before applying),
and staff switch their admin layout in **Admin → My account → Appearance** or from the palette button in the admin
header.

## Storefront themes

| Theme | Feel | Header | Products | Product page |
|---|---|---|---|---|
| **Classic** | Indian bazaar, teal and marigold | Search bar header with the awning edge and a category bar | Hairline grid | Three columns: gallery, details, buy box |
| **Bazaar** | Bold marketplace, indigo and sunflower | Two-tier header, centred search, "All categories" mega menu | Raised cards with discount ribbons | Two columns with a sticky buy panel |
| **Fresh** | Quick commerce, green and lavender | Compact app header with the delivery location pill | Small cards with an ADD button | Stacked, phone-first, sticky add bar |
| **Luxe** | Premium boutique, ivory, black and gold | Centred logo, minimal serif navigation | Tall borderless images | Large gallery with a sticky detail column |

Every theme works on phones, tablets and desktops, keeps every feature of the shop (search, filters, deals, wishlist,
compare, cart, checkout, orders, returns, help) and uses only the brand name and logo from Admin → Storefront.

## How it is built (frontend: `src/themes`)

```
src/themes/
  types.ts          the contract: tokens, layout options, slot components
  manifest.ts       every theme's data (tokens + layout), safe for server code and the admin picker
  slots.tsx         every theme's components, for the shop ("use client")
  context.tsx       ThemeProvider and useTheme(): the active theme's data and components
  css.ts            the CSS variables a theme sets on the shop (colours, fonts, radius, shadows, density)
  classic/ bazaar/ fresh/ luxe/
    theme.ts        tokens + layout options (data only)
    header.tsx footer.tsx mobile-nav.tsx product-tile.tsx
```

- **Tokens** are CSS variables on the `.theme-shop` element (`--c-primary`, `--f-display`, `--r-lg`, `--shadow-card`,
  ...). Tailwind's colours, fonts, radii and shadows read them, so every shop page follows the theme without code
  changes.
- **Slots** are the parts whose structure differs: `Header`, `Footer`, `MobileNav`, `ProductTile`. The shop layout and
  `components/product.tsx` render the active theme's slot.
- **Layout options** (`theme.layout`) let shared screens change arrangement without copying them: product grid style,
  home category and section style, filters on the side or on top, product page arrangement, cart summary placement,
  sign-in layout, page width.
- Each theme is a **module**: its folder plus one line in `manifest.ts`, one in `slots.tsx` and its id in
  `backend/app/services/themes.py`. Themes never import each other; a theme can reuse Classic's parts. Removing or
  changing one theme cannot break another.

### Adding a theme

1. Copy `src/themes/classic` to `src/themes/<id>` and change `theme.ts` (tokens, layout) and the slot components.
2. Add it to `manifest.ts` and `slots.tsx`, and its id to `THEMES` in `backend/app/services/themes.py`.
3. Check every screen at 390, 820 and 1440 px (`scripts`/UI sweep) and run the e2e theme spec.

The admin's colour choices for a theme are saved per theme (`site.theme_colors[<id>]`); brand colours
(`site.colors`) stay the colours of the Classic theme, the seller hub, the delivery partner app and emails.

### Preview

`/theme-preview?theme=<id>` sets a cookie for this browser only and opens the shop in that theme, with a bar to go
back. Nothing is saved; other visitors still see the live theme.

## Admin layouts (`src/components/admin-shell`)

| Layout | For |
|---|---|
| **Sidebar** (default) | The full menu on the left with sections, quick find (Ctrl+K) and collapsible groups |
| **Top navigation** | The menu as grouped drop-downs across the top; full-width pages |
| **Compact rail** | A slim dark icon rail that opens on hover or tap; the most room for tables |

Every layout shows the same menu (filtered by the staff member's role), badges, notifications, the AI assistant and
sign-out. The choice is stored per staff member (`users.ui_prefs.admin_layout`); the owner's default is in Admin →
Marketplace settings.
