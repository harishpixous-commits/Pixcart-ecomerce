import type { ThemeData } from "../types";

/** A premium boutique: a centred logo, serif headings, tall borderless product images, lots of space. */
export const luxe: ThemeData = {
  id: "luxe",
  name: "Luxe",
  tagline: "Boutique: centred logo, serif, airy and calm",
  description:
    "An editorial look for fashion, gifts and premium goods. A centred logo with a minimal menu, serif headings, tall borderless product images with lots of white space, text-chip categories, and a large gallery product page.",
  bestFor: ["Fashion", "Jewellery and gifts", "Premium brands"],
  chrome: "light",
  tokens: {
    ink: { ink: "#171717", ink_soft: "#4D4A45", ink_faint: "#7F7A71", line: "#E7E1D6" },
    fonts: { display: '"Playfair Display", Georgia, serif', sans: "Inter, system-ui, sans-serif" },
    headingTracking: "0.005em",
    radius: "square",
    shadow: "none",
  },
  layout: {
    container: "wide",
    productGrid: "airy",
    gridColumns: 4,
    home: { categories: "chips", sections: "plain" },
    listing: { filters: "topbar" },
    pdp: { layout: "gallery" },
    cart: { summary: "side" },
    auth: { layout: "split" },
  },
  presets: [
    { id: "noir", name: "Noir and gold", colors: { primary: "#111111", primary_dark: "#000000", accent: "#B8955A", buy: "#8C2F39", success: "#2F6B4F", page: "#F7F4EE" } },
    { id: "rose", name: "Ivory rose", colors: { primary: "#3D2B2E", primary_dark: "#24191B", accent: "#C9A27E", buy: "#9E3B4E", success: "#3E6B54", page: "#FBF6F3" } },
    { id: "emerald", name: "Emerald", colors: { primary: "#0F3D33", primary_dark: "#082820", accent: "#C5A46D", buy: "#8E2C48", success: "#2F6B4F", page: "#F5F3EE" } },
    { id: "slate", name: "Slate", colors: { primary: "#1F2937", primary_dark: "#111827", accent: "#A8A29E", buy: "#7C2D3A", success: "#2F6B4F", page: "#F4F4F2" } },
    { id: "sand", name: "Sand", colors: { primary: "#3F3A33", primary_dark: "#27231E", accent: "#D4B483", buy: "#8B3A2F", success: "#3A6B50", page: "#F6F1E8" } },
  ],
};
