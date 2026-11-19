"use client";

/* Pieces shared by the admin's delivery pages: status pills, partner avatar and the private document viewer. */

import clsx from "clsx";
import { FileText, Loader2, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal, Pill } from "@/components/ui";
import { downloadBlob } from "@/lib/api";
import type { KycStatus, Partner } from "@/lib/delivery-types";

const KYC: Record<KycStatus, { label: string; tone: "green" | "amber" | "red" | "gray" | "blue" }> = {
  draft: { label: "Not submitted", tone: "gray" },
  submitted: { label: "Waiting for review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Needs changes", tone: "red" },
};

export function KycPill({ status, active = true }: { status: KycStatus; active?: boolean }) {
  if (!active) return <Pill tone="red">Switched off</Pill>;
  const k = KYC[status] ?? { label: status, tone: "gray" as const };
  return <Pill tone={k.tone}>{k.label}</Pill>;
}

export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs font-semibold", online ? "text-leaf" : "text-ink-faint")}>
      <span className={clsx("h-2 w-2 rounded-full", online ? "bg-leaf shadow-[0_0_0_3px_rgba(30,142,62,0.2)]" : "bg-line")} /> {online ? "Online" : "Offline"}
    </span>
  );
}

export function PartnerAvatar({ p, size = "md" }: { p: Pick<Partner, "photo" | "name">; size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-9 w-9 text-sm" : "h-12 w-12 text-base";
  return p.photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.photo} alt="" className={clsx(cls, "shrink-0 rounded-full object-cover ring-2 ring-white")} />
  ) : (
    <span className={clsx(cls, "flex shrink-0 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock")}>{p.name.slice(0, 1).toUpperCase()}</span>
  );
}

export function Stars({ value, count }: { value: number; count: number }) {
  if (!count) return <span className="text-xs text-ink-faint">No ratings yet</span>;
  return <span className="inline-flex items-center gap-1 text-sm font-semibold"><Star className="h-4 w-4 fill-marigold text-marigold" aria-hidden /> {value.toFixed(1)} <span className="font-normal text-ink-faint">({count})</span></span>;
}

/** Opens a private file (KYC document or delivery proof) through the signed-in API and shows it in a modal. */
export function DocViewer({ path, title, onClose }: { path: string | null; title: string; onClose: () => void }) {
  const [file, setFile] = useState<{ path: string; url: string; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let url = "";
    downloadBlob(path).then((b) => {
      url = URL.createObjectURL(b);
      if (live) setFile({ path, url, type: b.type });
    }).catch(() => { if (live) setError("Could not open the file"); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  const shown = file && file.path === path ? file : null;
  return (
    <Modal open={path !== null} onClose={() => { setFile(null); setError(null); onClose(); }} title={title} wide>
      {error ? <p className="text-vermilion">{error}</p> : !shown ? (
        <div className="flex h-64 items-center justify-center text-ink-soft"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : shown.type === "application/pdf" ? (
        <div className="flex flex-col gap-2">
          <iframe src={shown.url} title={title} className="h-[70vh] w-full rounded-lg ring-1 ring-line" />
          <a href={shown.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-peacock"><FileText className="h-4 w-4" /> Open in a new tab</a>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.url} alt={title} className="mx-auto max-h-[70vh] rounded-lg object-contain ring-1 ring-line" />
      )}
    </Modal>
  );
}
