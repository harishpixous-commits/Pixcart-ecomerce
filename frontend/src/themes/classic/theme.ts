import type { ThemeData } from "@/themes/types";

/** The original look: teal and marigold, the market-stall awning, a hairline product grid, three-column product page. */
export const classic: ThemeData = {
  id: "classic",
  name: "Classic",
  tagline: "Indian bazaar: search-first header, hairline grid",
  description:
    "The original look. A search-first header with the awning edge and a category bar, products in a hairline grid, filters in a left column, and a three-column product page with the buy box on the right.",
  bestFor: ["Large catalogues", "Every category", "Desktop and phone"],
  chrome: "brand",
  tokens: {
    ink: { ink: "#1B2430", ink_soft: "#4A5565", ink_faint: "#7A8594", line: "#DCE3E8" },
    fonts: { display: '"Baloo 2", system-ui, sans-serif', sans: "Mukta, system-ui, sans-serif" },
    headingTracking: "0em",
    radius: "rounded",
    shadow: "none",
  },
  layout: {
    container: "wide",
    productGrid: "hairline",
    gridColumns: 5,
    home: { categories: "circles", sections: "panel" },
    listing: { filters: "sidebar" },
    pdp: { layout: "three" },
    cart: { summary: "side" },
    auth: { layout: "card" },
  },
  presets: [
    { id: "peacock", name: "Peacock", colors: { primary: "#0B5563", primary_dark: "#073B45", accent: "#F5A524", buy: "#D7263D", success: "#1A7F37", page: "#EEF2F4" } },
    { id: "midnight", name: "Midnight", colors: { primary: "#1E2A44", primary_dark: "#131C30", accent: "#F2B33D", buy: "#C8323C", success: "#1F7A4D", page: "#EEF0F4" } },
    { id: "mulberry", name: "Mulberry", colors: { primary: "#6B1F4E", primary_dark: "#4B1537", accent: "#F6B93B", buy: "#C0392B", success: "#2E7D4F", page: "#F4EFF2" } },
    { id: "forest", name: "Forest", colors: { primary: "#1F5130", primary_dark: "#143820", accent: "#E9B949", buy: "#B83227", success: "#2E7D32", page: "#EEF2EE" } },
    { id: "ocean", name: "Ocean", colors: { primary: "#0D4E8B", primary_dark: "#093762", accent: "#FFB547", buy: "#C62F2F", success: "#1D7A46", page: "#EDF2F7" } },
  ],
};
