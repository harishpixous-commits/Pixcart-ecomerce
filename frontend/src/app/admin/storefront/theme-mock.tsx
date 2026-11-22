"use client";

/*
 * A miniature of the shop's home page in a theme: its header, a category block in its category style and products
 * in its grid style, in the theme's own colours, fonts, corners and shadows (the theme's CSS variables are set on
 * the wrapper). Static markup, so a gallery of them is instant. Everything is sized in em and the font size follows
 * the box's width (container units), so the miniature scales like a picture at any size.
 */

import clsx from "clsx";
import { Heart, Menu, MapPin, Search, ShoppingBag, ShoppingCart, User } from "lucide-react";
import { themeVars } from "@/themes/css";
import type { ActiveTheme, ThemeLayout } from "@/themes/types";

type Variant = "classic" | "bazaar" | "fresh" | "luxe";

const TINTS = ["bg-peacock-light", "bg-marigold-light", "bg-vermilion-light", "bg-leaf-light"];
const PRICES = ["499", "1,299", "249", "899", "2,199", "349"];
const OFF = [20, 35, 15, 40, 25, 10];

/** The theme's variables with corner sizes in em, so corners shrink with the miniature. */
function mockVars(theme: ActiveTheme, classicRadius?: string): React.CSSProperties {
  const vars = themeVars(theme, classicRadius);
  for (const k of ["--r-lg", "--r-xl", "--r-2xl"]) vars[k] = vars[k].replace(/rem$/, "em");
  return vars as React.CSSProperties;
}

function Bar({ w, className }: { w: string; className?: string }) {
  return <span className={clsx("block h-[0.5em] shrink-0 rounded-full", className ?? "bg-ink/25")} style={{ width: w }} />;
}

const ICON = "h-[1.25em] w-[1.25em] shrink-0";

function Logo({ brand, className }: { brand: string; className: string }) {
  return <span className={clsx("shrink-0 truncate font-display font-bold leading-none", className)}>{brand}</span>;
}

/* ------------------------------------------------------------------ headers */

function Header({ variant, brand, pad }: { variant: Variant; brand: string; pad: string }) {
  if (variant === "bazaar") {
    return (
      <div className="bg-peacock text-white">
        <div className={clsx("flex h-[4.2em] items-center gap-[1em]", pad)}>
          <Logo brand={brand} className="max-w-[9em] text-[1.5em]" />
          <div className="mx-auto flex h-[2.3em] w-[52%] overflow-hidden rounded-full bg-white">
            <span className="flex flex-1 items-center px-[1em]"><Bar w="10em" className="bg-ink/15" /></span>
            <span className="flex w-[3.4em] items-center justify-center bg-marigold text-ink"><Search className={ICON} /></span>
          </div>
          <span className="flex items-center gap-[0.9em]"><User className={ICON} /><Heart className={ICON} /><ShoppingCart className={ICON} /></span>
        </div>
        <div className={clsx("flex h-[2.3em] items-center gap-[1.3em] bg-peacock-dark", pad)}>
          <span className="flex h-[1.6em] items-center gap-[0.4em] rounded-lg bg-marigold px-[0.6em] text-ink"><Menu className="h-[1em] w-[1em]" /><Bar w="4.5em" className="bg-ink/45" /></span>
          {["3em", "4em", "3.4em", "4.6em", "3em"].map((w, i) => <Bar key={i} w={w} className="bg-white/45" />)}
        </div>
      </div>
    );
  }
  if (variant === "fresh") {
    return (
      <div className="border-b border-line bg-white">
        <div className={clsx("flex h-[4.6em] items-center gap-[1em]", pad)}>
          <Logo brand={brand} className="max-w-[8em] text-[1.5em] text-peacock" />
          <span className="flex shrink-0 items-center gap-[0.4em] rounded-full bg-mist px-[0.7em] py-[0.45em]">
            <MapPin className="h-[1em] w-[1em] text-peacock" />
            <span className="flex flex-col gap-[0.3em]"><Bar w="3.6em" className="bg-ink/70" /><Bar w="5em" className="bg-ink/25" /></span>
          </span>
          <span className="flex h-[2.5em] min-w-0 flex-1 items-center gap-[0.6em] rounded-xl bg-mist px-[0.9em] text-ink-faint">
            <Search className={ICON} /><Bar w="9em" className="bg-ink/20" />
          </span>
          <User className={clsx(ICON, "text-ink-soft")} />
          <span className="flex h-[2.5em] shrink-0 items-center gap-[0.4em] rounded-lg bg-peacock px-[0.9em] text-white">
            <ShoppingCart className={ICON} /><Bar w="2.4em" className="bg-white/80" />
          </span>
        </div>
      </div>
    );
  }
  if (variant === "luxe") {
    return (
      <>
        <div className="flex h-[1.6em] items-center justify-center bg-ink"><Bar w="14em" className="bg-white/50" /></div>
        <div className="border-b border-line bg-white text-ink">
          <div className={clsx("grid h-[4.6em] grid-cols-[1fr_auto_1fr] items-center", pad)}>
            <span className="flex items-center gap-[0.7em]"><Menu className={ICON} /><Bar w="3em" className="bg-ink/40" /></span>
            <span className="max-w-[16em] truncate font-display text-[1.75em] uppercase leading-none tracking-[0.12em]">{brand}</span>
            <span className="flex justify-end gap-[0.9em]"><Search className={ICON} /><Heart className={ICON} /><ShoppingBag className={ICON} /></span>
          </div>
          <div className="flex h-[2.2em] items-center justify-center gap-[1.8em] border-t border-line">
            {["3em", "3.6em", "2.6em", "4em", "3em"].map((w, i) => <Bar key={i} w={w} className="bg-ink/35" />)}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="flex h-[1.6em] items-center justify-center bg-marigold"><Bar w="16em" className="bg-ink/35" /></div>
      <div className="bg-peacock text-white">
        <div className={clsx("flex h-[4.2em] items-center gap-[1em]", pad)}>
          <Logo brand={brand} className="max-w-[9em] text-[1.5em]" />
          <div className="flex h-[2.3em] min-w-0 flex-1 overflow-hidden rounded-lg bg-white">
            <span className="flex w-[4.2em] items-center justify-center border-r border-line bg-mist"><Bar w="2.2em" /></span>
            <span className="flex flex-1 items-center px-[0.8em]"><Bar w="9em" className="bg-ink/15" /></span>
            <span className="flex w-[3em] items-center justify-center bg-marigold text-ink"><Search className={ICON} /></span>
          </div>
          <span className="flex items-center gap-[0.9em]"><User className={ICON} /><ShoppingCart className={ICON} /></span>
        </div>
      </div>
      <div className="relative bg-white shadow-sm">
        {/* Classic's awning edge, scaled down */}
        <span
          className="absolute inset-x-0 top-0 block h-[0.6em]"
          style={{ backgroundImage: "radial-gradient(circle at 0.6em 0, rgb(var(--c-primary)) 0.575em, transparent 0.6em)", backgroundSize: "1.2em 0.6em", backgroundRepeat: "repeat-x" }}
        />
        <div className={clsx("flex h-[2.6em] items-end gap-[1.5em] pb-[0.6em]", pad)}>
          <MapPin className="h-[1em] w-[1em] text-ink-soft" />
          {["3.4em", "4em", "3em", "4.4em", "3.2em", "3.8em"].map((w, i) => <Bar key={i} w={w} />)}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ body */

function Block({ title, plain, children }: { title: string; plain: boolean; children: React.ReactNode }) {
  return (
    <div className={plain ? "" : "rounded-xl bg-white p-[1em] shadow-panel"}>
      <p className={clsx("mb-[0.7em] truncate font-display font-semibold leading-none text-ink", plain ? "text-[1.45em]" : "text-[1.15em]")}>{title}</p>
      {children}
    </div>
  );
}

function Categories({ kind }: { kind: ThemeLayout["home"]["categories"] }) {
  if (kind === "chips") {
    return (
      <div className="flex flex-wrap justify-center gap-[0.6em]">
        {["3em", "4.2em", "2.6em", "3.6em", "4.6em", "3em"].map((w, i) => (
          <span key={i} className="flex h-[2.1em] items-center rounded-full border border-line bg-white px-[1em]"><Bar w={w} className="bg-ink/45" /></span>
        ))}
      </div>
    );
  }
  if (kind === "squares") {
    return (
      <div className="grid grid-cols-8 gap-[0.55em]">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className="flex flex-col items-center gap-[0.45em]">
            <span className={clsx("relative block aspect-square w-full rounded-lg", TINTS[i % 4])}><span className="absolute inset-[26%] rounded-full bg-white/60" /></span>
            <Bar w="80%" />
          </span>
        ))}
      </div>
    );
  }
  if (kind === "cards") {
    return (
      <div className="grid grid-cols-6 gap-[0.7em]">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="flex flex-col items-center gap-[0.5em] rounded-lg bg-white p-[0.45em] shadow-card">
            <span className={clsx("relative block aspect-square w-full rounded-lg", TINTS[i % 4])}><span className="absolute inset-[24%] rounded-[30%] bg-white/60" /></span>
            <Bar w="70%" className="bg-ink/35" />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="flex justify-between gap-[0.6em]">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="flex flex-col items-center gap-[0.5em]">
          <span className={clsx("relative block h-[3.8em] w-[3.8em] rounded-full", TINTS[i % 4])}><span className="absolute inset-[28%] rounded-full bg-white/60" /></span>
          <Bar w="3.2em" />
        </span>
      ))}
    </div>
  );
}

function Tile({ i, variant, airy }: { i: number; variant: Variant; airy: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-[0.45em]">
      <span className={clsx("relative block w-full overflow-hidden rounded-lg", airy ? "aspect-[3/4]" : "aspect-square", TINTS[i % 4])}>
        <span className="absolute inset-[24%] rounded-[30%] bg-white/55" />
        {variant === "bazaar" && i % 2 === 0 && (
          <span className="absolute left-0 top-[0.6em] rounded-r-lg bg-vermilion px-[0.45em] text-[0.7em] font-bold leading-[1.6] text-white">-{OFF[i % 6]}%</span>
        )}
        {variant === "classic" && i === 1 && (
          <span className="absolute left-[0.4em] top-[0.4em] rounded-lg bg-vermilion px-[0.4em] text-[0.65em] font-bold leading-[1.6] text-white">Deal</span>
        )}
      </span>
      <Bar w="92%" className="bg-ink/55" />
      <Bar w="58%" className="bg-ink/25" />
      {(variant === "classic" || variant === "bazaar") && (
        <span className="flex items-center gap-[0.35em]">
          <span className="rounded-lg bg-leaf px-[0.4em] text-[0.65em] font-semibold leading-[1.5] text-white">4.{3 + (i % 5)}★</span>
          <Bar w="2em" className="bg-ink/15" />
        </span>
      )}
      <span className="flex items-center justify-between gap-[0.3em]">
        <span className={clsx("truncate font-display text-[1.05em] leading-none text-ink", variant === "luxe" ? "font-medium" : "font-bold")}>₹{PRICES[i % 6]}</span>
        {variant === "fresh" && <span className="shrink-0 rounded-lg border border-peacock bg-white px-[0.5em] text-[0.7em] font-bold leading-[1.6] text-peacock">ADD</span>}
      </span>
      {variant === "bazaar" && <span className="block h-[1.7em] rounded-lg bg-marigold" />}
    </span>
  );
}

function Products({ layout, n, variant }: { layout: ThemeLayout; n: number; variant: Variant }) {
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const tiles = Array.from({ length: n }, (_, i) => i);
  if (layout.productGrid === "hairline") {
    return (
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line" style={cols}>
        {tiles.map((i) => <span key={i} className="block bg-white p-[0.6em]"><Tile i={i} variant={variant} airy={false} /></span>)}
      </div>
    );
  }
  if (layout.productGrid === "cards") {
    return (
      <div className="grid gap-[0.7em]" style={cols}>
        {tiles.map((i) => <span key={i} className="block rounded-xl bg-white p-[0.5em] shadow-card"><Tile i={i} variant={variant} airy={false} /></span>)}
      </div>
    );
  }
  return (
    <div className="grid gap-[1.1em]" style={cols}>
      {tiles.map((i) => <Tile key={i} i={i} variant={variant} airy />)}
    </div>
  );
}

function Hero({ variant }: { variant: Variant }) {
  const light = variant === "fresh";
  return (
    <div className={clsx("relative flex h-[9em] items-center overflow-hidden rounded-xl px-[2em]", light ? "bg-peacock-light" : "bg-gradient-to-r from-peacock-dark to-peacock")}>
      <span className="relative z-10 flex flex-col items-start gap-[0.6em]">
        <span className={clsx("font-display text-[1.8em] font-bold leading-none", light ? "text-ink" : "text-white")}>New arrivals</span>
        <Bar w="12em" className={light ? "bg-ink/30" : "bg-white/60"} />
        <span className={clsx("mt-[0.2em] rounded-lg px-[1em] text-[0.85em] font-semibold leading-[2]", light ? "bg-peacock text-white" : variant === "luxe" ? "border border-white text-white" : "bg-marigold text-ink")}>
          Shop now
        </span>
      </span>
      <span className={clsx("absolute -right-[2em] -top-[3em] h-[13em] w-[13em] rounded-full", light ? "bg-white/50" : "bg-white/10")} />
      <span className={clsx("absolute right-[5em] top-[2.2em] h-[4.6em] w-[4.6em] rotate-12 rounded-xl", light ? "bg-marigold" : "bg-marigold/90")} />
    </div>
  );
}

/**
 * @param size "card": the gallery and the live card (4:3, four products); "large": the editor (natural height,
 *   a banner, as many products as the theme shows per row).
 */
export function ThemeMock({ theme, brand, classicRadius, size = "card", className }: {
  theme: ActiveTheme;
  brand: string;
  classicRadius?: string;
  size?: "card" | "large";
  className?: string;
}) {
  const { data } = theme;
  const layout = data.layout;
  const variant: Variant = (["classic", "bazaar", "fresh", "luxe"] as const).find((v) => v === data.id) ?? (data.chrome === "light" ? "fresh" : "classic");
  const plain = layout.home.sections === "plain";
  const pad = layout.container === "wide" ? "px-[1.4em]" : "px-[3.6em]";
  const large = size === "large";
  return (
    <div aria-hidden className={clsx("pointer-events-none select-none overflow-hidden", !large && "aspect-[4/3]", className)} style={{ containerType: "inline-size" }}>
      <div className="h-full bg-mist font-sans leading-tight text-ink" style={{ ...mockVars(theme, classicRadius), fontSize: "2cqw" }}>
        <Header variant={variant} brand={brand} pad={pad} />
        <div className={clsx("flex flex-col", pad, plain ? "gap-[1.6em] py-[1.6em]" : "gap-[1em] py-[1.2em]")}>
          {large && <Hero variant={variant} />}
          <Block title="Shop by category" plain={plain}><Categories kind={layout.home.categories} /></Block>
          <Block title="Top picks for you" plain={plain}><Products layout={layout} n={large ? layout.gridColumns : 4} variant={variant} /></Block>
        </div>
      </div>
    </div>
  );
}
