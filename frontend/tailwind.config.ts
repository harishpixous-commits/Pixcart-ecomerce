import type { Config } from "tailwindcss";

// Design tokens come from CSS variables: the brand colours from Admin → Storefront (app/layout.tsx) and, on shop
// pages, the active theme (src/themes/css.ts). A colour, font or shape change needs no rebuild. Colours are
// "R G B" triples so opacity modifiers (bg-peacock/20) keep working.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        peacock: { DEFAULT: v("primary"), dark: v("primary-dark"), light: v("primary-light") },
        marigold: { DEFAULT: v("accent"), dark: v("accent-dark"), light: v("accent-light") },
        vermilion: { DEFAULT: v("buy"), dark: v("buy-dark"), light: v("buy-light") },
        leaf: { DEFAULT: v("success"), light: v("success-light") },
        ink: { DEFAULT: v("ink"), soft: v("ink-soft"), faint: v("ink-faint") },
        mist: v("page"),
        line: v("line"),
      },
      borderRadius: {
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        "2xl": "var(--r-2xl)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        "card-hover": "var(--shadow-card-hover)",
        panel: "var(--shadow-panel)",
      },
      fontFamily: {
        display: "var(--f-display)",
        sans: "var(--f-sans)",
      },
      maxWidth: { shop: "var(--w-shop)" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
      },
      animation: {
        "fade-in": "fade-in 220ms ease-out both",
        "rise-in": "rise-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
      },
    },
  },
  plugins: [],
};
export default config;
