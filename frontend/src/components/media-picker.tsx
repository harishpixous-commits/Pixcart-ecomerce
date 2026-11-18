"use client";

import { ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Modal, Spinner, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

export type MediaItem = { id: string; url: string; label: string; at: string };

export async function uploadMedia(file: File, label = ""): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const r = await api<{ url: string }>("/api/admin/media", { method: "POST", form, query: label ? { label } : undefined });
  return r.url;
}

export function MediaGrid({ onPick, refreshKey = 0 }: { onPick?: (url: string) => void; refreshKey?: number }) {
  const toast = useToast();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<MediaItem[]>("/api/admin/media").then(setItems).catch(quietly);
  useEffect(() => { load(); }, [refreshKey]);

  async function upload(files: FileList) {
    setBusy(true);
    try {
      for (const f of Array.from(files).slice(0, 10)) await uploadMedia(f, f.name);
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Upload failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="mb-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-peacock/40 p-5 text-peacock hover:bg-peacock-light">
        {busy ? <Spinner /> : <ImagePlus className="h-5 w-5" />}
        <span className="font-semibold">Upload images</span>
        <span className="text-sm text-ink-soft">JPG, PNG or WebP, up to 5 MB each. Banners look best at 1600 × 600.</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => e.target.files && upload(e.target.files)} />
      </label>
      {!items ? <Spinner /> : items.length === 0 ? <p className="text-ink-faint">No images uploaded yet.</p> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((m) => (
            <li key={m.id} className="overflow-hidden rounded-lg border border-line bg-white">
              <button type="button" disabled={!onPick} onClick={() => onPick?.(m.url)} className="block aspect-[16/9] w-full bg-mist enabled:hover:opacity-80" aria-label={onPick ? `Use ${m.label}` : m.label}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.url} alt="" className="h-full w-full object-cover" />
              </button>
              <div className="flex items-center gap-1 p-2 text-xs">
                <span className="flex-1 truncate" title={m.label}>{m.label || "Image"}</span>
                {!onPick && <button type="button" className="rounded px-1.5 py-0.5 text-peacock hover:bg-peacock-light" onClick={() => { navigator.clipboard?.writeText(m.url); toast("Link copied"); }}>Copy link</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An image field: shows the current image, opens the library to choose or upload another. */
export function ImageField({ label, value, onChange, aspect = "aspect-[16/9]", hint }: { label: string; value: string; onChange: (url: string) => void; aspect?: string; hint?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p className="mb-1 font-medium">{label}</p>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(true)} className={`relative w-40 shrink-0 overflow-hidden rounded-lg border border-line bg-mist ${aspect}`} aria-label={`Choose ${label.toLowerCase()}`}>
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-ink-faint"><ImagePlus className="h-6 w-6" /></span>
          )}
        </button>
        <div className="flex flex-col items-start gap-1">
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>{value ? "Change" : "Choose image"}</Button>
          {value && <Button type="button" size="sm" variant="ghost" onClick={() => onChange("")}><Trash2 className="h-4 w-4" /> Remove</Button>}
          {hint && <p className="text-xs text-ink-faint">{hint}</p>}
        </div>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Media library" wide>
        <MediaGrid onPick={(u) => { onChange(u); setOpen(false); }} />
      </Modal>
    </div>
  );
}
