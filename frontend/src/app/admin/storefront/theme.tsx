"use client";

/*
 * Admin → Storefront → Theme and layout. The owner picks a theme from a gallery of miniatures, picks a colour preset
 * or changes any colour (with readable-text checks), changes any layout option, sees the real shop in a live preview
 * on a phone, tablet or computer, and applies it. Every theme keeps its own preset, colours and layout, so switching
 * back and forth never loses a choice. Saving uses PUT /api/admin/storefront/theme (theme fields only).
 */

import clsx from "clsx";
import { AlertTriangle, Check, ExternalLink, Eye, Laptop, RotateCcw, Smartphone, Tablet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { THEME_LIST, THEMES } from "@/themes/manifest";
import { EDITABLE_COLORS, LAYOUT_CHOICES, type EditableColor, type ThemeColors, type ThemeId } from "@/themes/types";
import { ThemeMock } from "./theme-mock";
import {
  HEX, LAYOUT_KEYS, LAYOUT_WORDS, changeCounts, colorChecks, differs, draftTheme, flatLayout, layoutWord, presetName, presetsFor, previewHref,
  ratioText, savedDraft, toSetting, type Draft, type LayoutKey, type PickerSite, type ThemeSaved,
} from "./theme-model";

const COLOR_LABELS: Record<EditableColor, { label: string; help: string }> = {
  primary: { label: "Main colour", help: "Header, links and selected states" },
  primary_dark: { label: "Dark main colour", help: "Footer and pressed states" },
  accent: { label: "Highlight", help: "Search button, badges and add-to-cart" },
  buy: { label: "Buy and sale", help: "Buy now, discounts and deal timers" },
  success: { label: "Success", help: "Ratings, in stock and confirmations" },
  page: { label: "Page background", help: "Behind panels and cards" },
};

/** A row of the six colours as small dots. */
function Swatches({ colors, size = "sm" }: { colors: ThemeColors; size?: "sm" | "md" }) {
  return (
    <span className="flex items-center" aria-hidden>
      {EDITABLE_COLORS.map((k) => (
        <span key={k} className={clsx("rounded-full ring-2 ring-white", size === "md" ? "-ml-1 h-5 w-5 first:ml-0" : "-ml-0.5 h-3.5 w-3.5 first:ml-0")} style={{ background: colors[k] }} />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ live preview window */

const DEVICES = [
  { id: "phone", label: "Phone", width: 390, icon: Smartphone },
  { id: "tablet", label: "Tablet", width: 820, icon: Tablet },
  { id: "desktop", label: "Computer", width: 1280, icon: Laptop },
] as const;

function PreviewWindow({ id, draft, onClose, onApply, applyLabel }: {
  id: ThemeId; draft: Draft; onClose: () => void; onApply: () => void; applyLabel: string;
}) {
  const [device, setDevice] = useState<(typeof DEVICES)[number]["id"]>("desktop");
  const [pages, setPages] = useState<{ label: string; to: string }[]>([
    { label: "Home", to: "/" }, { label: "Search", to: "/search?q=shoes" }, { label: "Cart", to: "/cart" }, { label: "Sign in", to: "/login" },
  ]);
  const [page, setPage] = useState("/");
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeBtn.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [onClose]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A category and a product to preview (the first of each).
  useEffect(() => {
    Promise.all([
      api<{ slug: string; name: string }[]>("/api/catalog/categories").catch(() => []),
      api<{ items: { slug: string }[] }>("/api/catalog/products", { query: { page: 1, sort: "popular" } }).catch(() => ({ items: [] })),
    ]).then(([cats, prods]) => {
      const extra: { label: string; to: string }[] = [];
      if (cats[0]) extra.push({ label: "Category", to: `/c/${cats[0].slug}` });
      if (prods.items[0]) extra.push({ label: "Product", to: `/p/${prods.items[0].slug}` });
      setPages((p) => [p[0], p[1], ...extra, ...p.slice(2)]);
    });
  }, []);

  const width = DEVICES.find((d) => d.id === device)!.width;
  const scale = box.w ? Math.min(1, (box.w - 32) / width) : 1;
  const src = previewHref(id, draft, page);
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-ink/80 p-2 sm:p-4" role="dialog" aria-modal="true" aria-label={`Live preview of ${THEMES[id].name}`} data-testid="theme-live-preview">
      <div className="flex flex-wrap items-center gap-2 rounded-t-xl bg-white px-3 py-2">
        <p className="mr-auto flex items-center gap-2 font-semibold"><Eye className="h-4 w-4 text-peacock" /> {THEMES[id].name}: live preview</p>
        <div className="flex rounded-lg bg-mist p-0.5" role="radiogroup" aria-label="Screen size">
          {DEVICES.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={device === d.id} onClick={() => setDevice(d.id)}
              className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium", device === d.id ? "bg-white text-peacock shadow-sm" : "text-ink-soft hover:text-ink")}>
              <d.icon className="h-4 w-4" /><span className="hidden sm:inline">{d.label}</span>
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="preview-page">Page</label>
        <select id="preview-page" value={page} onChange={(e) => setPage(e.target.value)} className="h-9 rounded-lg border border-line bg-white px-2 text-sm">
          {pages.map((p) => <option key={p.to} value={p.to}>{p.label}</option>)}
        </select>
        <a href={src} target="_blank" rel="noopener" className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-peacock hover:bg-mist">
          <ExternalLink className="h-4 w-4" /><span className="hidden md:inline">New tab</span>
        </a>
        <Button size="sm" onClick={onApply}>{applyLabel}</Button>
        <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close the preview" className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-mist"><X className="h-5 w-5" /></button>
      </div>
      <div ref={stage} className="relative flex-1 overflow-hidden rounded-b-xl bg-mist">
        {box.w > 0 && (
          <div className="absolute left-1/2 top-4 origin-top" style={{ width, height: (box.h - 32) / scale, transform: `translateX(-50%) scale(${scale})` }}>
            <iframe key={src} src={src} title={`${THEMES[id].name} preview`} className="h-full w-full rounded-lg border-0 bg-white shadow-2xl" />
          </div>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-white/80">Only you see this preview. Links inside it work; nothing is saved until you apply.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ the picker */

export function ThemeEditor() {
  const toast = useToast();
  const [site, setSite] = useState<PickerSite | null>(null);
  const [editing, setEditing] = useState<ThemeId>("classic");
  const [drafts, setDrafts] = useState<Partial<Record<ThemeId, Draft>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    api<PickerSite>("/api/admin/storefront/site").then((s) => { setSite(s); setEditing((s.theme as ThemeId) in THEMES ? (s.theme as ThemeId) : "classic"); }).catch(quietly);
  }, []);

  const live: ThemeId = site && (site.theme as ThemeId) in THEMES ? (site.theme as ThemeId) : "classic";
  const brand = site?.colors;
  const draftOf = useCallback((id: ThemeId): Draft | null => (site ? drafts[id] ?? savedDraft(site, id) : null), [site, drafts]);
  const dirtyIds = useMemo(() => (site && brand ? THEME_LIST.map((t) => t.id).filter((id) => drafts[id] && differs(id, drafts[id]!, savedDraft(site, id), brand)) : []), [site, brand, drafts]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirtyIds.length) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyIds.length]);

  const closePreview = useCallback(() => {
    setPreview(false);
    // the preview cookie is for this browser: clear it so the admin's own shop tabs show the live theme again
    fetch("/theme-preview?theme=off", { redirect: "manual" }).catch(() => {});
  }, []);

  if (!site || !brand) return <PageLoader />;
  const draft = draftOf(editing)!;
  const theme = draftTheme(site, editing, draft);
  const data = THEMES[editing];
  const checks = colorChecks(draft.colors, theme.ink.ink);
  const counts = changeCounts(editing, draft, brand);
  const dirty = dirtyIds.includes(editing);
  const isLive = editing === live;
  const update = (d: Partial<Draft>) => setDrafts((all) => ({ ...all, [editing]: { ...draft, ...d } }));

  async function save(switchTo: ThemeId) {
    if (!site || !brand) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<ThemeSaved>("/api/admin/storefront/theme", {
        method: "PUT", body: { theme: switchTo, settings: { [editing]: toSetting(editing, draft, brand) } },
      });
      setSite({ ...site, theme: r.theme, theme_settings: r.theme_settings });
      setDrafts((all) => { const next = { ...all }; delete next[editing]; return next; });
      setConfirm(false);
      toast(switchTo !== live ? `The shop now uses ${THEMES[switchTo].name}.` : isLive ? "Saved. Shoppers see the change now." : `${data.name} saved. The shop still uses ${THEMES[live].name}.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the theme");
    } finally {
      setBusy(false);
    }
  }

  const applyLabel = isLive ? "Save changes" : `Use ${data.name}`;
  return (
    <div className="flex flex-col gap-5" data-testid="theme-editor">
      {/* what shoppers see now */}
      <section className="flex flex-col gap-4 rounded-xl bg-white p-4 sm:flex-row sm:items-center sm:p-5" aria-label="Live theme">
        <ThemeMock theme={draftTheme(site, live, savedDraft(site, live))} brand={site.brand_name} classicRadius={site.radius} className="w-full shrink-0 rounded-lg ring-1 ring-line sm:w-56" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm text-ink-soft">Shoppers see</p>
          <p className="font-display text-2xl font-semibold">{THEMES[live].name} <span className="ml-1 rounded-full bg-leaf-light px-2 py-0.5 align-middle font-sans text-xs font-bold text-leaf">Live</span></p>
          <p className="text-sm text-ink-soft">{presetName(THEMES[live], savedDraft(site, live).preset)} · {THEMES[live].tagline}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setEditing(live)} disabled={editing === live}>Customise</Button>
        </div>
      </section>

      {/* gallery */}
      <section aria-labelledby="themes-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="themes-h" className="text-xl font-semibold">Themes</h2>
          <p className="text-sm text-ink-soft">Each theme changes colours, fonts and the layout of every page. Your choices are kept per theme.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Theme to edit">
          {THEME_LIST.map((t) => {
            const d = draftOf(t.id)!;
            const selected = t.id === editing;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={selected} onClick={() => setEditing(t.id)} data-testid={`theme-card-${t.id}`}
                className={clsx("pc-lift group flex flex-col overflow-hidden rounded-xl bg-white text-left ring-2 transition-shadow", selected ? "ring-peacock" : "ring-transparent hover:ring-line")}>
                <ThemeMock theme={draftTheme(site, t.id, d)} brand={site.brand_name} classicRadius={site.radius} className="w-full border-b border-line" />
                <span className="flex flex-1 flex-col gap-1.5 p-3">
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">{t.name}</span>
                    {t.id === live && <span className="rounded-full bg-leaf-light px-2 text-xs font-bold leading-5 text-leaf">Live</span>}
                    {dirtyIds.includes(t.id) && <span className="rounded-full bg-marigold-light px-2 text-xs font-bold leading-5 text-ink">Unsaved</span>}
                    {selected && <Check className="ml-auto h-4 w-4 text-peacock" aria-hidden />}
                  </span>
                  <span className="text-sm text-ink-soft">{t.tagline}</span>
                  <span className="mt-auto flex flex-wrap gap-1 pt-1">
                    {t.bestFor.map((b) => <span key={b} className="rounded-full bg-mist px-2 py-0.5 text-[11px] font-medium text-ink-soft">{b}</span>)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* editor */}
      <section aria-labelledby="edit-h" className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-xl bg-white p-4 sm:p-5">
            <h2 id="edit-h" className="text-xl font-semibold">{data.name}{isLive ? " (live)" : ""}</h2>
            <p className="mt-1 text-sm text-ink-soft">{data.description}</p>
          </div>

          <div className="rounded-xl bg-white p-4 sm:p-5">
            <h3 className="mb-3 font-semibold">Colour preset</h3>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Colour preset">
              {presetsFor(data, brand).map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={draft.preset === p.id} data-testid={`preset-${p.id}`}
                  onClick={() => update({ preset: p.id, colors: { ...p.colors } })}
                  className={clsx("flex items-center gap-3 rounded-lg border-2 px-3 py-2 text-left", draft.preset === p.id ? "border-peacock bg-peacock-light" : "border-line hover:border-peacock/50")}>
                  <Swatches colors={p.colors} size="md" />
                  <span className="text-sm font-medium">{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-white p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-semibold">Colours {counts.colors > 0 && <span className="text-sm font-normal text-ink-soft">({counts.colors} changed)</span>}</h3>
              {counts.colors > 0 && (
                <button type="button" className="flex items-center gap-1 text-sm font-semibold text-peacock hover:underline"
                  onClick={() => update({ colors: { ...presetsFor(data, brand).find((p) => p.id === draft.preset)!.colors } })}>
                  <RotateCcw className="h-3.5 w-3.5" /> Reset to the preset
                </button>
              )}
            </div>
            <ul className="flex flex-col divide-y divide-line">
              {EDITABLE_COLORS.map((k) => {
                const check = checks.find((c) => c.key === k)!;
                return (
                  <li key={k} className="flex flex-wrap items-center gap-3 py-2.5">
                    <input type="color" value={draft.colors[k]} aria-label={`${COLOR_LABELS[k].label} colour`}
                      onChange={(e) => update({ colors: { ...draft.colors, [k]: e.target.value.toUpperCase() } })}
                      className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-white p-1" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{COLOR_LABELS[k].label}</p>
                      <p className="text-xs text-ink-faint">{COLOR_LABELS[k].help}</p>
                    </div>
                    <HexField value={draft.colors[k]} label={COLOR_LABELS[k].label} onValid={(v) => update({ colors: { ...draft.colors, [k]: v } })} />
                    <span title={check.ok ? "Text on this colour is easy to read" : check.warning}
                      className={clsx("w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold", check.ok ? "bg-leaf-light text-leaf" : "bg-marigold-light text-ink")}>
                      {check.ok ? <Check className="mr-0.5 inline h-3 w-3" /> : <AlertTriangle className="mr-0.5 inline h-3 w-3" />}{ratioText(check.ratio)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {checks.some((c) => !c.ok) && (
              <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink" role="status">
                {checks.filter((c) => !c.ok).map((c) => <li key={c.key} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{c.warning}</li>)}
              </ul>
            )}
          </div>

          <div className="rounded-xl bg-white p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-semibold">Layout {counts.layout > 0 && <span className="text-sm font-normal text-ink-soft">({counts.layout} changed)</span>}</h3>
              {counts.layout > 0 && (
                <button type="button" className="flex items-center gap-1 text-sm font-semibold text-peacock hover:underline" onClick={() => update({ layout: {} })}>
                  <RotateCcw className="h-3.5 w-3.5" /> Use {data.name}&apos;s layout
                </button>
              )}
            </div>
            <div className="flex flex-col gap-3">
              {LAYOUT_KEYS.map((k) => <LayoutRow key={k} k={k} id={editing} draft={draft} onChange={(layout) => update({ layout })} />)}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-24 xl:self-start">
          <div className="overflow-hidden rounded-xl bg-white ring-1 ring-line">
            <ThemeMock theme={theme} brand={site.brand_name} classicRadius={site.radius} size="large" />
          </div>
          <p className="text-center text-xs text-ink-faint">A sketch of the home page. Use Live preview to see the real shop.</p>
        </div>
      </section>

      {/* the actions stay in reach while the long editor scrolls */}
      <div className="sticky bottom-2 z-20 flex flex-col gap-2">
        <ErrorNote message={error} />
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white/95 p-3 shadow-[0_-4px_20px_rgba(16,24,40,0.12)] ring-1 ring-line backdrop-blur">
          <p className="mr-auto min-w-0 text-sm">
            <span className="font-semibold">{data.name}</span>
            <span className="text-ink-soft"> · {presetName(data, draft.preset)}{dirty ? " · unsaved changes" : isLive ? " · live" : ""}</span>
          </p>
          {dirty && <Button variant="ghost" onClick={() => setDrafts((all) => { const next = { ...all }; delete next[editing]; return next; })}>Discard</Button>}
          <Button variant="secondary" onClick={() => setPreview(true)} data-testid="theme-preview-open"><Eye className="h-4 w-4" /> Live preview</Button>
          {!isLive && dirty && <Button variant="secondary" loading={busy} onClick={() => save(live)}>Save without using it</Button>}
          <Button loading={busy} disabled={isLive && !dirty} onClick={() => (isLive ? save(live) : setConfirm(true))} data-testid="theme-apply">{applyLabel}</Button>
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/60 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-h">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
            <h2 id="confirm-h" className="text-xl font-semibold">Use {data.name} for the shop?</h2>
            <p className="mt-2 text-ink-soft">Shoppers see {data.name} with {presetName(data, draft.preset)} right away. {THEMES[live].name} keeps its settings, so you can switch back at any time.</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button loading={busy} onClick={() => save(editing)} data-testid="theme-apply-confirm">Use {data.name}</Button>
            </div>
          </div>
        </div>
      )}
      {preview && (
        <PreviewWindow id={editing} draft={draft} onClose={closePreview} applyLabel={applyLabel}
          onApply={() => { closePreview(); if (isLive) save(live); else setConfirm(true); }} />
      )}
    </div>
  );
}

/** A hex text field that only passes valid colours on (typing "#12" waits until it is complete). */
function HexField({ value, label, onValid }: { value: string; label: string; onValid: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const bad = !HEX.test(text);
  return (
    <input value={text} aria-label={`${label} hex value`} aria-invalid={bad} spellCheck={false} maxLength={7}
      onChange={(e) => { const v = e.target.value.trim(); setText(v); if (HEX.test(v)) onValid(v.toUpperCase()); }}
      className={clsx("h-10 w-24 rounded-md border px-2 font-mono text-sm uppercase", bad ? "border-vermilion" : "border-line")} />
  );
}

/** One layout option: the theme's own choice, or one of the allowed values. */
function LayoutRow({ k, id, draft, onChange }: { k: LayoutKey; id: ThemeId; draft: Draft; onChange: (layout: Draft["layout"]) => void }) {
  const own = flatLayout(THEMES[id].layout)[k];
  const current = (draft.layout as Record<string, unknown>)[k] ?? own;
  const words = LAYOUT_WORDS[k];
  return (
    <fieldset className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <legend className="sr-only">{words.label}</legend>
      <div className="sm:w-40 sm:shrink-0">
        <p className="text-sm font-semibold">{words.label}</p>
        <p className="text-xs text-ink-faint">{words.help}</p>
      </div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={words.label}>
        {(LAYOUT_CHOICES[k] as readonly (string | number)[]).map((v) => (
          <button key={String(v)} type="button" role="radio" aria-checked={current === v}
            onClick={() => {
              const next = { ...draft.layout } as Record<string, unknown>;
              if (v === own) delete next[k];
              else next[k] = v;
              onChange(next as Draft["layout"]);
            }}
            className={clsx("rounded-lg border px-2.5 py-1.5 text-sm", current === v ? "border-peacock bg-peacock text-white" : "border-line bg-white hover:border-peacock/60")}>
            {layoutWord(k, v)}{v === own && <span className={clsx("ml-1 text-[11px]", current === v ? "text-white/80" : "text-ink-faint")}>(theme)</span>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
