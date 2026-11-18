"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Expand, Play, X, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ProductVideo } from "@/lib/types";

/*
 * Product photos and videos, the way shoppers know it from big marketplaces:
 * - Desktop: hover a thumbnail to show it; hover the photo to magnify it in a panel beside it (lens + zoom view);
 *   click the photo for the full-screen viewer.
 * - Phone: swipe between photos; tap for the full-screen viewer.
 * - Full-screen viewer: VIDEOS and IMAGES tabs, large photo (click to zoom, arrows/keys to move), video player.
 * Zoom on/off and strength come from Admin → Marketplace settings → Product page.
 */

type Props = { images: string[]; videos?: ProductVideo[]; title: string; zoom?: boolean; zoomLevel?: number };

const dur = (s: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";
function useCanHover() {
  // A mouse or trackpad (not touch): only then does hover-to-zoom make sense.
  return useSyncExternalStore(
    (cb) => { const mq = window.matchMedia(HOVER_QUERY); mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); },
    () => window.matchMedia(HOVER_QUERY).matches,
    () => false,
  );
}

function VideoThumb({ v, active, onClick, onEnter }: { v: ProductVideo; active?: boolean; onClick: () => void; onEnter?: () => void }) {
  return (
    <button type="button" onClick={onClick} onMouseEnter={onEnter} aria-label={`Play video${v.title ? `: ${v.title}` : ""}`}
      className={clsx("relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-ink", active ? "border-peacock" : "border-line")}>
      {v.poster_url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={v.poster_url} alt="" className="h-full w-full object-cover opacity-90" />
        : <video src={`${v.url}#t=0.5`} preload="metadata" muted className="h-full w-full object-cover" />}
      <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow"><Play className="ml-0.5 h-3.5 w-3.5 fill-ink text-ink" /></span></span>
    </button>
  );
}

/* ---------------------------------------------------------------- hover zoom */

function ZoomImage({ src, alt, level, enabled, onOpen }: { src: string; alt: string; level: number; enabled: boolean; onOpen: () => void }) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [lens, setLens] = useState<{ x: number; y: number; w: number; h: number; iw: number; ih: number; ix: number; iy: number } | null>(null);

  const move = useCallback((e: React.MouseEvent) => {
    const box = boxRef.current, img = imgRef.current;
    if (!enabled || !box || !img || !img.naturalWidth) return;
    const b = box.getBoundingClientRect();
    // Where the photo actually sits inside the square box (object-contain leaves margins).
    const scale = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
    const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
    const ix = (b.width - iw) / 2, iy = (b.height - ih) / 2;
    const w = Math.min(iw, b.width / level), h = Math.min(ih, b.height / level);
    const mx = e.clientX - b.left, my = e.clientY - b.top;
    if (mx < ix || mx > ix + iw || my < iy || my > iy + ih) { setLens(null); return; }
    const x = Math.min(Math.max(mx - w / 2, ix), ix + iw - w);
    const y = Math.min(Math.max(my - h / 2, iy), iy + ih - h);
    setLens({ x, y, w, h, iw, ih, ix, iy });
  }, [enabled, level]);

  return (
    <div className="relative">
      <button ref={boxRef} type="button" onClick={onOpen} onMouseMove={move} onMouseLeave={() => setLens(null)}
        className={clsx("relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-white", enabled ? "cursor-crosshair" : "cursor-zoom-in")}
        aria-label="Open the full-size photo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={src} alt={alt} className="h-full w-full object-contain" draggable={false} />
        {lens && (
          <span aria-hidden className="pointer-events-none absolute border border-peacock/60 bg-white/30"
            style={{ left: lens.x, top: lens.y, width: lens.w, height: lens.h, backgroundImage: "radial-gradient(rgba(11,85,99,.25) 1px, transparent 1px)", backgroundSize: "4px 4px" }} />
        )}
      </button>
      {lens && (
        // The magnified view sits beside the photo, over the product details (as on large marketplaces).
        <div aria-hidden className="pointer-events-none absolute left-[calc(100%+16px)] top-0 z-30 hidden overflow-hidden rounded-xl border border-line bg-white shadow-2xl lg:block"
          style={{
            width: lens.w * level, height: lens.h * level,
            backgroundImage: `url("${src}")`, backgroundRepeat: "no-repeat",
            backgroundSize: `${lens.iw * level}px ${lens.ih * level}px`,
            backgroundPosition: `${-(lens.x - lens.ix) * level}px ${-(lens.y - lens.iy) * level}px`,
          }} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- full-screen viewer */

function Viewer({ images, videos, title, start, onClose }: { images: string[]; videos: ProductVideo[]; title: string; start: { tab: "images" | "videos"; index: number }; onClose: () => void }) {
  const [tab, setTab] = useState(images.length ? start.tab : "videos");
  const [img, setImg] = useState(start.tab === "images" ? start.index : 0);
  const [vid, setVid] = useState(start.tab === "videos" ? start.index : 0);
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState("50% 50%");
  const closeRef = useRef<HTMLButtonElement>(null);
  const go = useCallback((d: number) => { setZoomed(false); setImg((i) => (i + d + images.length) % images.length); }, [images.length]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (tab === "images" && e.key === "ArrowRight") go(1);
      else if (tab === "images" && e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; prev?.focus(); };
  }, [tab, go, onClose]);

  const touch = useRef<number | null>(null);
  return (
    <div className="fixed inset-0 z-[70] flex items-stretch justify-center bg-ink/60 p-0 sm:p-6" onMouseDown={onClose} role="dialog" aria-modal="true" aria-label={`${title}: photos and videos`}>
      <div className="flex w-full max-w-[1400px] flex-col overflow-hidden bg-white sm:rounded-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-6 border-b border-line px-4 sm:px-8">
          {videos.length > 0 && (
            <button type="button" onClick={() => setTab("videos")} className={clsx("-mb-px border-b-2 py-3 text-sm font-semibold uppercase tracking-wide", tab === "videos" ? "border-peacock text-peacock" : "border-transparent text-ink-soft hover:text-ink")}>
              Videos
            </button>
          )}
          {images.length > 0 && (
            <button type="button" onClick={() => setTab("images")} className={clsx("-mb-px border-b-2 py-3 text-sm font-semibold uppercase tracking-wide", tab === "images" ? "border-peacock text-peacock" : "border-transparent text-ink-soft hover:text-ink")}>
              Images
            </button>
          )}
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-full p-2 hover:bg-mist"><X className="h-6 w-6" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-white p-2 sm:p-6">
            {tab === "images" ? (
              <>
                <div className="flex h-full w-full items-center justify-center overflow-hidden"
                  onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
                  onTouchEnd={(e) => { if (touch.current !== null) { const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); touch.current = null; } }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={images[img]} alt={`${title}, photo ${img + 1} of ${images.length}`} draggable={false}
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`); setZoomed((z) => !z); }}
                    onMouseMove={(e) => { if (zoomed) { const r = e.currentTarget.getBoundingClientRect(); setOrigin(`${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`); } }}
                    className={clsx("max-h-[72vh] max-w-full select-none object-contain transition-transform duration-200", zoomed ? "scale-[2.2] cursor-zoom-out" : "cursor-zoom-in")}
                    style={{ transformOrigin: origin }} />
                </div>
                {images.length > 1 && <>
                  <button type="button" onClick={() => go(-1)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow ring-1 ring-line hover:bg-mist"><ChevronLeft className="h-6 w-6" /></button>
                  <button type="button" onClick={() => go(1)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow ring-1 ring-line hover:bg-mist"><ChevronRight className="h-6 w-6" /></button>
                </>}
                <p className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/70 px-3 py-0.5 text-xs text-white">{img + 1} / {images.length}{!zoomed ? " · click to zoom" : ""}</p>
              </>
            ) : (
              <div className="flex w-full max-w-4xl flex-col gap-2">
                <video key={videos[vid].url} src={videos[vid].url} poster={videos[vid].poster_url || undefined} controls autoPlay playsInline
                  className="max-h-[70vh] w-full rounded-xl bg-black" aria-label={videos[vid].title || title} />
                <p className="text-lg font-semibold">{videos[vid].title || title}</p>
              </div>
            )}
          </div>
          <aside className="flex max-h-[30vh] shrink-0 flex-col gap-3 overflow-y-auto border-t border-line p-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
            <p className="hidden text-lg leading-snug lg:block">{title}</p>
            {tab === "images" ? (
              <div className="grid grid-cols-5 gap-2 lg:grid-cols-4">
                {images.map((src, i) => (
                  <button key={src + i} type="button" onClick={() => { setImg(i); setZoomed(false); }} aria-label={`Photo ${i + 1}`}
                    className={clsx("aspect-square overflow-hidden rounded-lg border-2 bg-white", i === img ? "border-peacock" : "border-line hover:border-peacock/50")}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="h-full w-full object-contain" />
                  </button>
                ))}
              </div>
            ) : (
              <>
                <p className="rounded-lg bg-mist px-3 py-2 font-semibold">Videos for this product</p>
                {videos.map((v, i) => (
                  <button key={v.url} type="button" onClick={() => setVid(i)} className={clsx("flex items-start gap-3 rounded-lg p-1 text-left", i === vid ? "ring-2 ring-marigold" : "hover:bg-mist")}>
                    <span className="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-ink">
                      {v.poster_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={v.poster_url} alt="" className="h-full w-full object-cover" />
                        : <video src={`${v.url}#t=0.5`} preload="metadata" muted className="h-full w-full object-cover" />}
                      <Play className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
                      {v.duration_s > 0 && <span className="absolute bottom-0.5 right-0.5 rounded bg-ink/80 px-1 text-[11px] text-white">{dur(v.duration_s)}</span>}
                    </span>
                    <span className="text-sm">{v.title || title}</span>
                  </button>
                ))}
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- gallery */

export function ProductGallery({ images, videos = [], title, zoom = true, zoomLevel = 2.5 }: Props) {
  const list = images.length ? images : [];
  const [active, setActive] = useState(0);
  const [viewer, setViewer] = useState<{ tab: "images" | "videos"; index: number } | null>(null);
  const canHover = useCanHover();
  const swipeRef = useRef<HTMLDivElement>(null);
  const level = Math.min(Math.max(zoomLevel, 1.5), 4);

  // Phone: keep the dots in step with swiping.
  const onSwipe = () => {
    const el = swipeRef.current;
    if (el) setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  if (!list.length && !videos.length) {
    return <div className="flex aspect-square items-center justify-center rounded-xl bg-mist text-ink-faint">No image</div>;
  }
  return (
    <div>
      {/* desktop and tablet */}
      <div className="hidden gap-3 sm:flex">
        <div className="flex max-h-[560px] flex-col gap-2 overflow-y-auto pr-1">
          {list.map((src, i) => (
            <button key={src + i} type="button" onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onClick={() => setViewer({ tab: "images", index: i })}
              className={clsx("h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-white", i === active ? "border-peacock" : "border-line hover:border-peacock/50")}
              aria-label={`Photo ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="h-full w-full object-contain" />
            </button>
          ))}
          {videos.map((v, i) => (
            <div key={v.url} className="flex flex-col items-center">
              <VideoThumb v={v} onClick={() => setViewer({ tab: "videos", index: i })} />
              <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Video</span>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {list.length ? (
            <ZoomImage src={list[Math.min(active, list.length - 1)]} alt={title} level={level} enabled={zoom && canHover} onOpen={() => setViewer({ tab: "images", index: active })} />
          ) : (
            <button type="button" onClick={() => setViewer({ tab: "videos", index: 0 })} className="flex aspect-square w-full items-center justify-center rounded-xl bg-ink text-white"><Play className="h-12 w-12" /></button>
          )}
          <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-ink-faint">
            {zoom && canHover ? <><ZoomIn className="h-4 w-4" />Roll over the photo to zoom in · click for full view</> : <><Expand className="h-4 w-4" />Click the photo for full view</>}
          </p>
        </div>
      </div>

      {/* phone */}
      <div className="sm:hidden">
        <div ref={swipeRef} onScroll={onSwipe} className="flex snap-x snap-mandatory overflow-x-auto rounded-xl bg-white [scrollbar-width:none]">
          {list.map((src, i) => (
            <button key={src + i} type="button" onClick={() => setViewer({ tab: "images", index: i })} className="aspect-square w-full shrink-0 snap-center" aria-label={`Open photo ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={i === 0 ? title : ""} className="h-full w-full object-contain" loading={i === 0 ? "eager" : "lazy"} />
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-center gap-1.5">
          {list.length > 1 && list.map((_, i) => <span key={i} className={clsx("h-1.5 rounded-full transition-all", i === active ? "w-4 bg-peacock" : "w-1.5 bg-line")} />)}
          {videos.length > 0 && (
            <button type="button" onClick={() => setViewer({ tab: "videos", index: 0 })} className="ml-2 inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-white">
              <Play className="h-3 w-3 fill-white" />{videos.length === 1 ? "Video" : `${videos.length} videos`}
            </button>
          )}
        </div>
      </div>

      {/* Rendered on <body>: the gallery sits in a sticky column, which would otherwise keep the viewer under the site header. */}
      {viewer && createPortal(<Viewer images={list} videos={videos} title={title} start={viewer} onClose={() => setViewer(null)} />, document.body)}
    </div>
  );
}
