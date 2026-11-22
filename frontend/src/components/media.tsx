"use client";

/*
 * Images and videos in storefront blocks (hero slides, banners, card tiles, the media block). Admins pick either
 * from the media library (Admin → Storefront); a video plays muted and looped, starts only while it is on screen,
 * shows its image as the poster, and does not play by itself for shoppers who ask for reduced motion.
 *
 * <MediaFill image video playing /> fills its box. Videos that play by themselves need a way to pause them (WCAG
 * 2.2.2): render <VideoToggle> beside the block (outside any link) and pass its state as `playing`.
 */

import clsx from "clsx";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** True for a video file from the media library (mp4 or webm). */
export function isVideoUrl(url: string | undefined | null): boolean {
  return Boolean(url && /\.(mp4|webm)(?:[?#].*)?$/i.test(url));
}

function subscribeMotion(cb: () => void) {
  const m = window.matchMedia("(prefers-reduced-motion: reduce)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** The shopper asked their device for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
}

export function MediaFill({ image, video, alt = "", className, mediaClassName, fit = "cover", eager = false, playing = true }: {
  image?: string;
  video?: string;
  /** describes the picture; leave empty when the block's heading says it all */
  alt?: string;
  className?: string;
  mediaClassName?: string;
  fit?: "cover" | "contain";
  /** load at once (the first hero slide) instead of when scrolled near */
  eager?: boolean;
  /** false pauses the video (the block's pause button) */
  playing?: boolean;
}) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const fitClass = fit === "contain" ? "object-contain" : "object-cover";

  useEffect(() => {
    const el = ref.current;
    if (!el || !video) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && e.intersectionRatio > 0.2), { threshold: [0, 0.2, 0.6] });
    io.observe(el);
    return () => io.disconnect();
  }, [video]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !video) return;
    el.muted = true; // autoplay needs muted set on the element (React does not render the attribute)
    if (visible && playing && !reduced) el.play().catch(() => {});
    else el.pause();
  }, [visible, playing, reduced, video]);

  if (video) {
    return (
      <video
        ref={ref}
        src={video}
        poster={image || undefined}
        muted
        loop
        playsInline
        preload={eager ? "auto" : "metadata"}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={clsx("h-full w-full", fitClass, className, mediaClassName)}
      />
    );
  }
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" className={clsx("h-full w-full", fitClass, className, mediaClassName)} />;
  }
  return <div className={clsx("h-full w-full bg-mist", className)} aria-hidden />;
}

/** A small round play/pause button for a block with a video (place it outside the block's link). */
export function VideoToggle({ playing, onToggle, className, tone = "dark" }: { playing: boolean; onToggle: () => void; className?: string; tone?: "dark" | "light" }) {
  return (
    <button type="button" onClick={onToggle} aria-label={playing ? "Pause video" : "Play video"} aria-pressed={!playing}
      className={clsx("pc-press flex h-8 w-8 items-center justify-center rounded-full shadow-sm backdrop-blur",
        tone === "dark" ? "bg-ink/60 text-white hover:bg-ink/80" : "bg-white/85 text-ink hover:bg-white", className)}>
      {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
    </button>
  );
}
