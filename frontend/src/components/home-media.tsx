"use client";

/*
 * Pictures and videos on the home page: banners (single and in a banner grid) and the "Image or video block" (the
 * `media` section). Each takes an image, a video (the image is then its poster) or both, picked from the media
 * library in Admin → Storefront → Home page. A video plays muted on a loop while it is on screen and gets a pause
 * button placed beside its link (never inside it); visitors who ask for less motion see the poster.
 */

import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";
import { MediaFill, VideoToggle, useReducedMotion } from "@/components/media";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";

/** Storefront text with {brand} and {free_delivery_amount} filled in. */
function useT() {
  const site = useSite();
  return (x: string | undefined) => fillTokens(x ?? "", site);
}

/** A page of the store, or another site in a new tab. */
function BlockLink({ href, className, label, children }: { href: string; className?: string; label?: string; children: React.ReactNode }) {
  if (href.startsWith("https://")) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className={className} aria-label={label}>{children}</a>;
  }
  return <Link href={href} className={className} aria-label={label}>{children}</Link>;
}

/* ---------------------------------------------------------------- banners */

export type BannerCfg = { image: string; video?: string; link: string; heading?: string; text?: string; cta?: string };

/** A single banner, or one banner of a banner grid (`compact`). The image sets its height; a video plays over it. */
export function MediaBanner({ image, video, link, heading, text, cta, compact }: BannerCfg & { compact?: boolean }) {
  const t = useT();
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(true);
  if (!image && !video) return null;
  const body = (
    <div className="relative h-full w-full">
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt={heading ? "" : "Banner"} className="h-full w-full rounded-xl object-cover" />
      )}
      {video && (
        <MediaFill image={image} video={video} alt={heading || image ? "" : "Banner"} playing={playing}
          className={clsx("rounded-xl", image ? "absolute inset-0" : "block aspect-video")} />
      )}
      {(heading || text || cta) && (
        <div className={clsx("absolute inset-0 flex flex-col justify-center gap-1 rounded-xl bg-gradient-to-r from-ink/60 to-transparent text-white", compact ? "p-4" : "p-6 sm:p-10")}>
          {heading && <p className={clsx("max-w-md font-display font-bold", compact ? "text-xl" : "text-2xl sm:text-4xl")}>{t(heading)}</p>}
          {text && <p className={clsx("max-w-md text-white/90", compact ? "text-sm" : "sm:text-lg")}>{t(text)}</p>}
          {cta && <span className="mt-1 self-start rounded-lg bg-marigold px-3 py-1.5 text-sm font-semibold text-ink">{t(cta)}</span>}
        </div>
      )}
    </div>
  );
  // Without a video the markup is exactly the original banner's.
  const fill = video ? "h-full" : "";
  const node = !link ? (
    <div className={clsx("overflow-hidden rounded-xl", fill)}>{body}</div>
  ) : (
    <BlockLink href={link} className={clsx("block overflow-hidden rounded-xl", fill)}>{body}</BlockLink>
  );
  if (!video) return node;
  return (
    <div className="relative h-full">
      {node}
      {!reduced && <VideoToggle playing={playing} onToggle={() => setPlaying((x) => !x)} className={clsx("absolute z-10", compact ? "right-2 top-2" : "right-3 top-3")} />}
    </div>
  );
}

/* ---------------------------------------------------------------- the "Image or video block" */

export type MediaCfg = {
  image?: string; video?: string; link?: string; heading?: string; text?: string; cta?: string;
  align?: "left" | "center"; tone?: "light" | "dark"; aspect?: string; width?: "contained" | "full"; controls?: boolean;
};

/* The block's shape. A 21:9 strip is too low for words on a phone, so phones get 16:9. */
const ASPECT: Record<string, string> = {
  "21/9": "aspect-video sm:aspect-[21/9]",
  "16/9": "aspect-video",
  "4/3": "aspect-[4/3]",
  "1/1": "aspect-square",
  "4/5": "aspect-[4/5]",
};
/** Contained blocks keep the whole picture in view on large screens: tall shapes get narrower instead of taller. */
const CAP: Record<string, string> = { "21/9": "", "16/9": "", "4/3": "lg:max-w-[880px]", "1/1": "lg:max-w-[600px]", "4/5": "lg:max-w-[500px]" };
/** Beside the words (large screens): the picture's column. */
const SPLIT: Record<string, string> = {
  "4/3": "lg:grid-cols-[minmax(0,620px)_minmax(0,1fr)]",
  "1/1": "lg:grid-cols-[minmax(0,500px)_minmax(0,1fr)]",
  "4/5": "lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]",
};

function Words({ cfg, light, center, size }: { cfg: MediaCfg; light: boolean; center: boolean; size: "overlay" | "side" | "caption" }) {
  const t = useT();
  return (
    <>
      {cfg.heading && (
        <h2 className={clsx("max-w-2xl font-bold",
          size === "overlay" && "line-clamp-2 text-xl sm:line-clamp-none sm:text-4xl",
          size === "side" && "text-3xl xl:text-4xl",
          size === "caption" && "text-xl sm:text-2xl")}>{t(cfg.heading)}</h2>
      )}
      {cfg.text && (
        <p className={clsx("max-w-xl", light ? "text-white/90" : "text-ink-soft",
          size === "overlay" ? "line-clamp-2 text-sm sm:line-clamp-3 sm:text-lg" : size === "side" ? "text-lg" : "text-[15px]")}>{t(cfg.text)}</p>
      )}
      {cfg.cta && (size !== "caption" || cfg.link) && (
        <span className={clsx("pc-press mt-1.5 inline-flex items-center rounded-lg bg-marigold font-semibold text-ink shadow-sm transition-colors group-hover:bg-marigold-dark",
          size === "overlay" ? "px-4 py-2 text-sm sm:mt-3 sm:px-5 sm:py-2.5 sm:text-base" : "px-5 py-2.5 text-[15px]", center ? "self-center" : "self-start")}>
          {t(cfg.cta)}
        </span>
      )}
    </>
  );
}

/** The "Image or video block": a picture or video with optional words, a button and a link, in five shapes. */
export function MediaBlock({ cfg, title }: { cfg: MediaCfg; title?: string }) {
  const reduced = useReducedMotion();
  const [playing, setPlaying] = useState(true);
  const image = cfg.image || "";
  const video = cfg.video || "";
  if (!image && !video) return null;
  const aspect = ASPECT[cfg.aspect ?? ""] ? (cfg.aspect as string) : "16/9";
  const full = cfg.width === "full";
  const light = cfg.tone !== "dark";
  const center = cfg.align === "center";
  const portrait = aspect === "1/1" || aspect === "4/5";
  const hasWords = Boolean(cfg.heading || cfg.text || cfg.cta);
  const name = cfg.heading || title || "Featured";
  const roundCls = full ? "" : "rounded-xl";
  const bleed = full ? "-mx-3 sm:-mx-4" : "";

  // The video's own controls: the shopper plays it (with sound if they like); the words sit under it.
  if (cfg.controls && video) {
    return (
      <section aria-label={name} className={clsx(bleed, !full && clsx("mx-auto w-full", CAP[aspect]))}>
        <div className={clsx("relative overflow-hidden bg-black", ASPECT[aspect], roundCls, full && "lg:max-h-[min(80vh,760px)] lg:w-full")}>
          <video src={video} poster={image || undefined} controls playsInline preload="metadata" aria-label={name} className="absolute inset-0 h-full w-full object-contain" />
        </div>
        {hasWords && (
          <div className={clsx("flex flex-col gap-1.5 pt-3", center && "items-center text-center", full && "px-3 sm:px-4")}>
            <Words cfg={cfg} light={false} center={center} size="caption" />
            {cfg.cta && cfg.link && (
              <BlockLink href={cfg.link} className={clsx("pc-press mt-1 inline-flex items-center rounded-lg bg-marigold px-5 py-2.5 text-[15px] font-semibold text-ink hover:bg-marigold-dark", center ? "self-center" : "self-start")}>
                {cfg.cta}
              </BlockLink>
            )}
          </div>
        )}
      </section>
    );
  }

  // Tall shapes with words, in a contained block: the words sit beside the picture on large screens.
  const split = !full && hasWords && Boolean(SPLIT[aspect]);
  const showToggle = Boolean(video) && !reduced;
  const toggle = showToggle && (
    <VideoToggle playing={playing} onToggle={() => setPlaying((x) => !x)} className="absolute right-3 top-3 z-10" />
  );
  const overlay = hasWords && (
    <div className={clsx("absolute inset-0 flex flex-col gap-2 p-4 sm:gap-2.5 sm:p-10",
      portrait ? "justify-end" : "justify-center",
      center ? "items-center text-center" : "items-start",
      light ? clsx("text-white", portrait ? "bg-gradient-to-t from-ink/80 via-ink/30 to-transparent" : center ? "bg-ink/45" : "bg-gradient-to-r from-ink/75 via-ink/35 to-transparent") : "text-ink",
      split && "lg:hidden")}>
      <Words cfg={cfg} light={light} center={center} size="overlay" />
    </div>
  );
  const media = (
    <div className={clsx("relative overflow-hidden bg-mist", ASPECT[aspect], roundCls, full && "lg:max-h-[min(80vh,760px)] lg:w-full")}>
      <MediaFill image={image} video={video} alt={hasWords ? "" : name} playing={playing}
        className="absolute inset-0 transition-transform duration-500 motion-safe:group-hover:scale-[1.02]" />
      {overlay}
    </div>
  );
  const wrap = (node: React.ReactNode, cls?: string, label?: string) =>
    cfg.link ? <BlockLink href={cfg.link} label={label} className={clsx("group block", cls)}>{node}</BlockLink> : <div className={cls}>{node}</div>;

  if (split) {
    return (
      <section aria-label={name} className={clsx("shop-panel overflow-hidden lg:grid lg:items-center", SPLIT[aspect])}>
        <div className="relative">
          {wrap(media, undefined, name)}
          {toggle}
        </div>
        {wrap(
          <div className={clsx("flex flex-col gap-3 px-6 py-10 xl:px-14", center && "items-center text-center")}>
            <Words cfg={cfg} light={false} center={center} size="side" />
          </div>,
          "hidden lg:block",
        )}
      </section>
    );
  }
  return (
    <section aria-label={name} className={clsx("relative", bleed, !full && clsx("mx-auto w-full", CAP[aspect]))}>
      {wrap(media, undefined, hasWords ? undefined : name)}
      {toggle}
    </section>
  );
}
