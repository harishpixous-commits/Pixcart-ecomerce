import type { ThemeData } from "../types";

/** Quick commerce: an app-like compact header, dense category tiles, small cards with an ADD button. */
export const fresh: ThemeData = {
  id: "fresh",
  name: "Fresh",
  tagline: "Quick commerce: app-like, ADD buttons, fast",
  description:
    "Built for fast, everyday shopping on phones. A compact header with the delivery-location pill and a big search, dense category tiles, small product cards with an ADD button, filters in a bar on top, and a cart bar that stays at the bottom.",
  bestFor: ["Groceries", "Daily essentials", "Phone shoppers"],
  chrome: "light",
  tokens: {
    ink: { ink: "#1C2321", ink_soft: "#4B5652", ink_faint: "#7A8480", line: "#E3E8E4" },
    fonts: { display: '"Plus Jakarta Sans", system-ui, sans-serif', sans: '"Plus Jakarta Sans", system-ui, sans-serif' },
    headingTracking: "-0.015em",
    radius: "soft",
    shadow: "soft",
  },
  layout: {
    container: "wide",
    productGrid: "cards",
    gridColumns: 6,
    home: { categories: "squares", sections: "plain" },
    listing: { filters: "topbar" },
    pdp: { layout: "two" },
    cart: { summary: "sticky" },
    auth: { layout: "card" },
  },
  presets: [
    { id: "leaf", name: "Leaf", colors: { primary: "#0C831F", primary_dark: "#08621A", accent: "#FCD34D", buy: "#D6336C", success: "#0C831F", page: "#F4F6F3" } },
    { id: "berry", name: "Berry", colors: { primary: "#B3135A", primary_dark: "#8A0E45", accent: "#FFD23F", buy: "#0B7A75", success: "#15803D", page: "#FBF3F6" } },
    { id: "citrus", name: "Citrus", colors: { primary: "#C2410C", primary_dark: "#9A3412", accent: "#FDE047", buy: "#1D4ED8", success: "#15803D", page: "#FFF7ED" } },
    { id: "ocean", name: "Ocean", colors: { primary: "#0369A1", primary_dark: "#075985", accent: "#FCD34D", buy: "#BE185D", success: "#15803D", page: "#F0F7FB" } },
    { id: "mint", name: "Mint", colors: { primary: "#047857", primary_dark: "#065F46", accent: "#FDE68A", buy: "#C2410C", success: "#047857", page: "#F0FAF6" } },
  ],
};
