"use client";

import clsx from "clsx";
import { Camera, CheckCircle2, FileUp, Loader2, RefreshCw } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Partner } from "@/lib/delivery-types";

/**
 * A big, thumb-friendly upload box for the partner's photo and KYC documents. On phones it opens the camera
 * (back camera for documents, front camera for the selfie); PDFs work from a computer.
 */
export function UploadTile({ kind, label, hint, done, preview, onDone, disabled }: {
  kind: "photo" | "license" | "id_proof" | "vehicle_rc"; label: string; hint?: string; done: boolean; preview?: string;
  onDone: (p: Partner) => void; disabled?: boolean;
}) {
  const toast = useToast();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const photo = kind === "photo";

  async function upload(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const p = await api<Partner>(`/api/delivery/me/docs/${kind}`, { method: "POST", form });
      onDone(p);
      toast(photo ? "Photo saved" : `${label} uploaded`);
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not upload. Try a clearer photo or a smaller file.", "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={`upload-${kind}`}>
      <label htmlFor={id} className={clsx("group relative flex cursor-pointer items-center gap-4 rounded-2xl border-2 border-dashed p-4 transition-colors",
        done ? "border-leaf/40 bg-leaf-light/40" : "border-line bg-white hover:border-peacock hover:bg-peacock-light/30",
        (disabled || busy) && "pointer-events-none opacity-60")}>
        {photo && preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover ring-4 ring-white" />
        ) : (
          <span className={clsx("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl", done ? "bg-leaf text-white" : "bg-peacock-light text-peacock")}>
            {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : done ? <CheckCircle2 className="h-7 w-7" /> : photo ? <Camera className="h-7 w-7" /> : <FileUp className="h-7 w-7" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{label}</span>
          <span className="block text-sm text-ink-soft">{busy ? "Uploading…" : done ? "Uploaded. Tap to replace." : hint ?? (photo ? "Take a clear selfie" : "Photo or PDF, up to 5 MB")}</span>
        </span>
        {done && !busy && <RefreshCw className="h-5 w-5 shrink-0 text-ink-faint group-hover:text-peacock" aria-hidden />}
        <input ref={input} id={id} type="file" className="sr-only" disabled={disabled || busy}
          accept={photo ? "image/*" : "image/*,application/pdf"} capture={photo ? "user" : undefined}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
      </label>
    </div>
  );
}
