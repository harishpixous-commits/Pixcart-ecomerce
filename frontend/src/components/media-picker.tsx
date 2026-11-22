"use client";

/*
 * The media library (Admin → Storefront → Media library) and the image and video fields that pick from it.
 * Images take the product photo pipeline (checked, resized, saved as WebP, up to 5 MB); MP4 and WebM videos are
 * stored as uploaded, up to the video size limit in Admin → Product page. GET /api/admin/media returns each item's
 * kind ("image" or "video") and takes ?kind= to list only one of them.
 *
 * <ImageField> and <VideoField> show a live preview of the chosen file and open <MediaLibrary>, a dialog that can sit
 * on top of another dialog (Escape and clicks outside close only the library).
 */

import clsx from "clsx";
import { Check, Copy, Film, ImagePlus, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isVideoUrl, MediaFill, useReducedMotion } from "@/components/media";
import { Button, useToast } from "@/components/ui";
import { api, ApiError, quietly, uploadWithProgress } from "@/lib/api";
import { useSite } from "@/lib/site";

export type MediaKind = "image" | "video";
/** What a picker takes: images only, videos only, or either. */
export type MediaAccept = MediaKind | "any";
export type MediaItem = { id: string; url: string; label: string; at: string; kind?: MediaKind };

export const VIDEO_HINT = "Plays muted on a loop; the image is shown until it loads and for shoppers who turn off motion";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/webm"];
const IMAGE_MB = 5;
const MB = 1024 * 1024;
const FILTERS: [MediaAccept, string][] = [["any", "All"], ["image", "Images"], ["video", "Videos"]];

/** An item's kind (sent by the API; told apart by the file type in the address for older replies). */
export function mediaKind(m: { url: string; kind?: MediaKind }): MediaKind {
  return m.kind ?? (isVideoUrl(m.url) ? "video" : "image");
}

/** The largest video the library takes: the product video limit from Admin → Product page. */
function useVideoLimit(): number {
  return useSite().gallery?.max_video_mb ?? 50;
}

/** Uploads one image or video to the library and returns the new item. */
export function uploadMediaItem(file: File, label = "", onProgress: (fraction: number) => void = () => {}): Promise<MediaItem> {
  const query = label ? `?label=${encodeURIComponent(label.slice(0, 120))}` : "";
  return uploadWithProgress<MediaItem>(`/api/admin/media${query}`, file, onProgress);
}

/** Uploads one image or video to the library and returns its address. */
export async function uploadMedia(file: File, label = ""): Promise<string> {
  return (await uploadMediaItem(file, label)).url;
}

/** Why a file cannot be uploaded here, or null when it can (the server checks the content again). */
function fileProblem(f: File, accept: MediaAccept, videoMb: number): string | null {
  const video = VIDEO_TYPES.includes(f.type) || (!f.type && /\.(mp4|webm)$/i.test(f.name));
  const image = IMAGE_TYPES.includes(f.type) || (!f.type && /\.(jpe?g|png|webp)$/i.test(f.name));
  if (video && accept === "image") return `${f.name} is a video. Choose an image here.`;
  if (image && accept === "video") return `${f.name} is an image. Choose an MP4 or WebM video here.`;
  if (!video && !image) {
    const wanted = accept === "video" ? "an MP4 or WebM video" : accept === "image" ? "a JPG, PNG or WebP image" : "a JPG, PNG or WebP image, or an MP4 or WebM video";
    return `${f.name} cannot be used. Upload ${wanted}.`;
  }
  if (video && f.size > videoMb * MB) return `${f.name} is larger than ${videoMb} MB, the video limit.`;
  if (image && f.size > IMAGE_MB * MB) return `${f.name} is larger than ${IMAGE_MB} MB, the image limit.`;
  return null;
}

function uploadCopy(accept: MediaAccept, videoMb: number): { title: string; note: string; types: string } {
  const images = `JPG, PNG or WebP up to ${IMAGE_MB} MB`;
  const videos = `MP4 or WebM up to ${videoMb} MB`;
  if (accept === "image") return { title: "Upload images", note: `${images} each. Banners look best at 1600 × 600.`, types: IMAGE_TYPES.join(",") };
  if (accept === "video") return { title: "Upload videos", note: `${videos} each. Short, silent loops work best.`, types: VIDEO_TYPES.join(",") };
  return { title: "Upload images or videos", note: `Images: ${images}. Videos: ${videos}.`, types: [...IMAGE_TYPES, ...VIDEO_TYPES].join(",") };
}

function VideoBadge() {
  return (
    <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-ink/75 px-2 py-0.5 text-[11px] font-semibold text-white">
      <Film className="h-3 w-3" aria-hidden /> Video
    </span>
  );
}

function FilterTabs({ value, onChange }: { value: MediaAccept; onChange: (v: MediaAccept) => void }) {
  return (
    <div role="group" aria-label="Show" className="inline-flex rounded-lg bg-mist p-1">
      {FILTERS.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={clsx("h-10 rounded-md px-3.5 text-sm font-medium transition-colors sm:h-8",
            value === v ? "bg-white text-peacock shadow-sm" : "text-ink-soft hover:text-ink")}>
          {label}
        </button>
      ))}
    </div>
  );
}

function MediaTile({ m, picked, onPick }: { m: MediaItem; picked: boolean; onPick?: (url: string, item: MediaItem) => void }) {
  const toast = useToast();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const video = mediaKind(m) === "video";
  const name = m.label || (video ? "Video" : "Image");
  // videos stay still on their first frame and play (muted) while pointed at or focused
  const preview = (on: boolean) => {
    const el = ref.current;
    if (!el) return;
    if (on && !reduced) {
      el.muted = true;
      el.play().catch(() => {});
    } else el.pause();
  };
  const thumb = (
    <>
      {video ? (
        <video ref={ref} src={`${m.url}#t=0.1`} muted loop playsInline preload="metadata" aria-hidden className="h-full w-full object-cover" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      )}
      {video && <VideoBadge />}
      {picked && (
        <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-peacock text-white shadow-card">
          <Check className="h-4 w-4" aria-hidden />
        </span>
      )}
    </>
  );
  return (
    <li onMouseEnter={() => preview(true)} onMouseLeave={() => preview(false)} onFocus={() => preview(true)} onBlur={() => preview(false)}
      className={clsx("overflow-hidden rounded-lg border bg-white transition-shadow", picked ? "border-peacock ring-2 ring-peacock" : "border-line", onPick && "hover:shadow-card")}>
      {onPick ? (
        <button type="button" onClick={() => onPick(m.url, m)} aria-label={`Use ${name}${picked ? " (in use now)" : ""}`}
          className="group relative block aspect-[16/9] w-full overflow-hidden bg-mist">
          {thumb}
          <span className="pointer-events-none absolute inset-0 bg-ink/0 transition-colors group-hover:bg-ink/10" />
        </button>
      ) : (
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-mist">{thumb}</div>
      )}
      <div className="flex min-h-9 items-center gap-1 px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-ink-soft" title={m.label}>{picked ? <b className="font-semibold text-peacock">In use · </b> : null}{name}</span>
        {!onPick && (
          <button type="button" aria-label={`Copy the link to ${name}`} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium text-peacock hover:bg-peacock-light"
            onClick={() => { navigator.clipboard?.writeText(m.url); toast("Link copied"); }}>
            <Copy className="h-3.5 w-3.5" aria-hidden /> Copy link
          </button>
        )}
      </div>
    </li>
  );
}

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4";

function GridSkeleton() {
  return (
    <ul className={GRID} aria-busy="true" aria-label="Loading the media library">
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="overflow-hidden rounded-lg border border-line bg-white">
          <div className="skeleton aspect-[16/9]" />
          <div className="flex h-9 items-center px-2"><div className="skeleton h-3 w-2/3 rounded" /></div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The library: upload (button or drag and drop) and a grid of everything uploaded, newest first. With `onPick` it is
 * a picker (choosing an item calls it; uploading a single file picks it at once); without, each item has a copy-link
 * button. `accept` limits what is listed and uploaded; "any" shows an All / Images / Videos filter.
 */
export function MediaGrid({ onPick, refreshKey = 0, accept = "any", selected }: {
  onPick?: (url: string, item: MediaItem) => void;
  refreshKey?: number;
  accept?: MediaAccept;
  /** the address in use now, marked in the grid */
  selected?: string;
}) {
  const toast = useToast();
  const videoMb = useVideoLimit();
  const [filter, setFilter] = useState<MediaAccept>("any");
  const shown: MediaAccept = accept === "any" ? filter : accept;
  const key = `${shown}|${refreshKey}`;
  // the list remembers the filter it is for, so switching shows placeholders without resetting state in an effect
  const [list, setList] = useState<{ key: string; items: MediaItem[] } | null>(null);
  const [progress, setProgress] = useState<{ name: string; at: number; of: number; done: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let live = true;
    api<MediaItem[]>("/api/admin/media", { query: shown === "any" ? undefined : { kind: shown } })
      .then((items) => { if (live) setList({ key, items }); })
      .catch(quietly);
    return () => { live = false; };
  }, [key, shown]);
  const items = list?.key === key ? list.items : null;

  async function upload(files: File[]) {
    if (!files.length || progress) return;
    const errors: string[] = [];
    const ready = files.slice(0, 10).filter((f) => {
      const problem = fileProblem(f, accept, videoMb);
      if (problem) errors.push(problem);
      return !problem;
    });
    if (files.length > 10) errors.push("Upload up to 10 files at a time.");
    setProblems([]);
    const added: MediaItem[] = [];
    for (let i = 0; i < ready.length; i++) {
      const f = ready[i];
      const step = { name: f.name, at: i + 1, of: ready.length };
      setProgress({ ...step, done: 0 });
      try {
        added.push(await uploadMediaItem(f, f.name, (done) => setProgress({ ...step, done })));
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof ApiError ? e.message : "the upload failed. Try again."}`);
      }
    }
    setProgress(null);
    setProblems(errors);
    if (!added.length) return;
    const fits = added.filter((m) => shown === "any" || mediaKind(m) === shown).reverse();
    setList((l) => (l && l.key === key ? { ...l, items: [...fits, ...l.items] } : l));
    if (onPick && files.length === 1 && (accept === "any" || mediaKind(added[0]) === accept)) onPick(added[0].url, added[0]);
    else toast(added.length === 1 ? "Uploaded to the media library" : `${added.length} files uploaded to the media library`);
  }

  const copy = uploadCopy(accept, videoMb);
  const busy = progress !== null;
  return (
    <div className="flex flex-col gap-3">
      <label
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); upload(Array.from(e.dataTransfer.files)); }}
        className={clsx("flex items-center gap-3 rounded-xl border-2 border-dashed p-4 transition-colors",
          busy ? "cursor-wait border-line opacity-70" : "cursor-pointer",
          !busy && (dragging ? "border-peacock bg-peacock-light" : "border-peacock/40 hover:bg-peacock-light"))}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock">
          <Upload className="h-5 w-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-semibold text-peacock">{copy.title}<span className="hidden font-normal text-ink-soft sm:inline"> or drop them here</span></span>
          <span className="text-sm text-ink-soft">{copy.note}</span>
        </span>
        <input type="file" multiple accept={copy.types} className="sr-only" disabled={busy}
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; upload(files); }} />
      </label>

      {progress && (
        <div role="status" className="rounded-lg bg-mist px-3 py-2 text-sm">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">
              {progress.done >= 1 ? "Saving" : "Uploading"} {progress.name}{progress.of > 1 ? ` (${progress.at} of ${progress.of})` : ""}
            </span>
            <span className="shrink-0 tabular-nums text-ink-soft">{Math.round(progress.done * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-peacock transition-[width] duration-200" style={{ width: `${Math.max(3, progress.done * 100)}%` }} />
          </div>
        </div>
      )}
      {problems.length > 0 && (
        <ul role="alert" className="flex flex-col gap-0.5 rounded-lg bg-vermilion-light px-3 py-2 text-sm text-vermilion">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
        {accept === "any" ? <FilterTabs value={filter} onChange={setFilter} /> : <p className="text-sm font-semibold text-ink">{accept === "video" ? "Your videos" : "Your images"}</p>}
        {items && items.length > 0 && (
          <p className="text-sm text-ink-faint">{items.length === 1 ? "1 file" : `${items.length} files`}{onPick ? " · choose one to use it" : ""}</p>
        )}
      </div>

      {!items ? <GridSkeleton /> : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-soft">
          {shown === "video" ? <Film className="h-8 w-8 text-ink-faint" aria-hidden /> : <ImagePlus className="h-8 w-8 text-ink-faint" aria-hidden />}
          <p>{shown === "video" ? "No videos yet." : shown === "image" ? "No images yet." : "Nothing uploaded yet."} Upload one above.</p>
        </div>
      ) : (
        <ul className={clsx(GRID, "animate-fade-in")}>
          {items.map((m) => <MediaTile key={m.id} m={m} picked={!!selected && selected === m.url} onPick={onPick} />)}
        </ul>
      )}
    </div>
  );
}

/** The library as a dialog for picking one file. It can open on top of another dialog. */
export function MediaLibrary({ open, onClose, onPick, accept = "any", selected, title = "Media library" }: {
  open: boolean;
  onClose: () => void;
  onPick?: (url: string, item: MediaItem) => void;
  accept?: MediaAccept;
  selected?: string;
  title?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // listening on window in the capture phase runs before a dialog underneath, so Escape closes only this one
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      back?.focus();
    };
  }, [open]);
  if (!open) return null;
  // a portal keeps the dialog fixed to the screen even inside another dialog
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 animate-fade-in sm:items-center sm:p-4" onMouseDown={onClose}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-panel outline-none animate-rise-in sm:max-w-3xl sm:rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="-mr-1.5 flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-mist" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain p-4 sm:p-5">
          <MediaGrid accept={accept} selected={selected} onPick={onPick} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (url: string) => void;
  /** the preview's shape, a Tailwind aspect class */
  aspect?: string;
  hint?: string;
  /** row: label on top, preview beside the buttons; compact: a smaller preview with the label beside it */
  layout?: "row" | "compact";
};

/** An image or video field: a live preview of the chosen file and buttons to choose another (from the library) or remove it. */
export function MediaField({ label, value, onChange, accept = "image", aspect = "aspect-[16/9]", hint, poster, layout = "row" }: FieldProps & {
  accept?: MediaKind;
  /** a video's cover picture (usually the block's image), shown until the video plays */
  poster?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const video = accept === "video";
  const lower = label.toLowerCase();
  const compact = layout === "compact";
  const preview = (
    <button type="button" tabIndex={-1} onClick={() => setOpen(true)} aria-label={`${value ? "Change" : "Choose"} ${lower}`}
      className={clsx("group relative shrink-0 overflow-hidden rounded-lg border border-line bg-mist", compact ? "w-28 sm:w-32" : "w-40", aspect)}>
      {value ? (
        video ? <MediaFill image={poster || undefined} video={value} /> : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-full w-full object-cover" />
        )
      ) : (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-faint transition-colors group-hover:text-peacock">
          {video ? <Film className="h-5 w-5" aria-hidden /> : <ImagePlus className="h-5 w-5" aria-hidden />}
          <span className="text-[11px] font-medium">{video ? "No video" : "No image"}</span>
        </span>
      )}
      {value && video && <VideoBadge />}
    </button>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>{value ? "Change" : video ? "Choose video" : "Choose image"}</Button>
      {value && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")} aria-label={`Remove ${lower}`} title="Remove">
          <Trash2 className="h-4 w-4" aria-hidden />{!compact && "Remove"}
        </Button>
      )}
    </div>
  );
  return (
    <div className="min-w-0">
      {compact ? (
        <div className="flex items-start gap-3">
          {preview}
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            <p className="text-sm font-medium text-ink">{label}</p>
            {actions}
            {hint && <p className="text-xs text-ink-faint">{hint}</p>}
          </div>
        </div>
      ) : (
        <>
          <p className="mb-1 text-sm font-medium text-ink">{label}</p>
          <div className="flex items-start gap-3">
            {preview}
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              {actions}
              {hint && <p className="text-xs text-ink-faint">{hint}</p>}
            </div>
          </div>
        </>
      )}
      <MediaLibrary open={open} onClose={close} accept={accept} selected={value} title={video ? "Choose a video" : "Choose an image"}
        onPick={(url) => { onChange(url); setOpen(false); }} />
    </div>
  );
}

/** An image field: shows the current image, opens the library to choose or upload another. */
export function ImageField(props: FieldProps) {
  return <MediaField {...props} accept="image" />;
}

/** An optional video field; pass the block's image as `poster` so the preview shows what shoppers see first. */
export function VideoField({ label = "Video (optional)", hint = VIDEO_HINT, ...rest }: Omit<FieldProps, "label"> & { label?: string; poster?: string }) {
  return <MediaField {...rest} label={label} hint={hint} accept="video" />;
}
