import type { Config } from "tailwindcss";

// Colours come from CSS variables that the server fills from Admin → Storefront → Theme,
// so a brand change needs no rebuild. Values are "R G B" triples.
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
        ink: { DEFAULT: "#1B2430", soft: "#4A5565", faint: "#7A8594" },
        mist: v("page"),
        line: "#DCE3E8",
      },
      borderRadius: {
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        "2xl": "var(--r-2xl)",
      },
      fontFamily: {
        display: ['"Baloo 2"', "system-ui", "sans-serif"],
        sans: ["Mukta", "system-ui", "sans-serif"],
      },
      maxWidth: { shop: "1280px" },
    },
  },
  plugins: [],
};
export default config;
