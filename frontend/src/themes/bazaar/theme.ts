import type { ThemeData } from "@/themes/types";

/** A bold, high-energy marketplace: a two-tier header with a mega menu, category cards, raised product cards. */
export const bazaar: ThemeData = {
  id: "bazaar",
  name: "Bazaar",
  tagline: "Big store: mega menu, raised cards, bold colour",
  description:
    "A big-store feel for a wide catalogue. A two-tier header with a centred search and an all-categories mega menu, category cards, raised product cards with discount ribbons, and a two-column product page.",
  bestFor: ["Electronics", "Sales and festivals", "Wide catalogues"],
  chrome: "brand",
  tokens: {
    ink: { ink: "#151B2E", ink_soft: "#4A5270", ink_faint: "#7C84A0", line: "#E1E5EE" },
    fonts: { display: "Poppins, system-ui, sans-serif", sans: "Inter, system-ui, sans-serif" },
    headingTracking: "-0.01em",
    radius: "rounded",
    shadow: "lifted",
  },
  layout: {
    container: "wide",
    productGrid: "cards",
    gridColumns: 5,
    home: { categories: "cards", sections: "panel" },
    listing: { filters: "sidebar" },
    pdp: { layout: "two" },
    cart: { summary: "side" },
    auth: { layout: "split" },
  },
  presets: [
    { id: "indigo", name: "Indigo sun", colors: { primary: "#2B3A8C", primary_dark: "#1C2766", accent: "#FFC93C", buy: "#D03E21", success: "#13855C", page: "#F1F3F8" } },
    { id: "crimson", name: "Crimson", colors: { primary: "#9B1B30", primary_dark: "#6E1322", accent: "#FFD166", buy: "#C2410C", success: "#1E7F4F", page: "#F7F1F2" } },
    { id: "teal", name: "Teal and coral", colors: { primary: "#0F5E68", primary_dark: "#0A4249", accent: "#FFB703", buy: "#D62839", success: "#2A7F4F", page: "#EEF4F5" } },
    { id: "royal", name: "Royal purple", colors: { primary: "#4A2C8F", primary_dark: "#331E66", accent: "#FFC857", buy: "#D7263D", success: "#1E7F4F", page: "#F3F1F8" } },
    { id: "graphite", name: "Graphite", colors: { primary: "#23262F", primary_dark: "#15171C", accent: "#FFB020", buy: "#D6336C", success: "#127A4B", page: "#F2F3F5" } },
  ],
};
