"use client";

/** The one-time welcome popup. Shows only when Admin → Growth → Promo popup is on, once per browser until its words change. */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { api, quietly } from "@/lib/api";

type Popup = { enabled: boolean; title?: string; body?: string; button_label?: string; link?: string; delay_seconds?: number };

export function PromoPopup() {
  const [p, setP] = useState<Popup | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    api<Popup>("/api/promo-popup").then((x) => {
      if (!x.enabled) return;
      const key = "pc_popup_" + (x.title ?? "") + "|" + (x.body ?? "");
      try { if (localStorage.getItem(key)) return; } catch { /* storage blocked: show it each visit */ }
      setP(x);
      timer = setTimeout(() => setOpen(true), (x.delay_seconds ?? 5) * 1000);
    }).catch(quietly);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  function close() {
    setOpen(false);
    try { localStorage.setItem("pc_popup_" + (p?.title ?? "") + "|" + (p?.body ?? ""), "1"); } catch { /* ignore */ }
  }
  if (!p || !open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="promo-popup" onClick={close}>
      <div role="dialog" aria-modal="true" aria-labelledby="promo-popup-h" className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 id="promo-popup-h" className="text-xl font-semibold">{p.title}</h2>
        {p.body && <p className="mt-2 text-ink-soft">{p.body}</p>}
        <div className="mt-4 flex gap-2">
          {p.link && p.button_label && <Link href={p.link} onClick={close} className="inline-flex min-h-11 items-center rounded-lg bg-peacock px-4 font-semibold text-white">{p.button_label}</Link>}
          <Button variant="ghost" type="button" onClick={close}>Close</Button>
        </div>
      </div>
    </div>
  );
}
