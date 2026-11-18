"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, Monitor, Plus, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { ImageField } from "@/components/media-picker";
import { Button, ErrorNote, Field, Input, Modal, PageLoader, Pill, Select, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date } from "@/lib/format";
import type { CategoryNode, ProductCard } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Section = { id: string; kind: string; kind_label: string; title: string; config: Record<string, any>; is_active: boolean; device: "all" | "mobile" | "desktop"; starts_at: string | null; ends_at: string | null };

const KIND_HELP: Record<string, string> = {
  hero: "Large sliding banners at the top of the page",
  categories: "Tiles or chips linking to categories",
  products: "A row or grid of products: deals, bestsellers, new, a category, or ones you pick",
  banner: "One wide banner with a link",
  banner_grid: "2 to 4 banners side by side",
  text: "A paragraph, heading or note, written in simple formatting",
  usp: "A strip of short promises such as cash on delivery or easy returns",
  recent: "Products the shopper looked at recently (only shown if there are any)",
};

const STARTER: Record<string, Record<string, any>> = {
  hero: { slides: [{ image: "", heading: "", text: "", cta: "Shop now", link: "/search" }], autoplay: true },
  categories: { slugs: [], style: "tiles" },
  products: { source: "deals", limit: 12, layout: "row" },
  banner: { image: "", heading: "", text: "", cta: "", link: "/search" },
  banner_grid: { items: [{ image: "", link: "/search", heading: "", text: "", cta: "" }, { image: "", link: "/search", heading: "", text: "", cta: "" }] },
  text: { markdown: "## A heading\n\nWrite something for your shoppers.", align: "left" },
  usp: { items: [{ icon: "badge", text: "Verified sellers" }, { icon: "wallet", text: "Cash on delivery" }, { icon: "return", text: "Easy returns" }] },
  recent: {},
};

const ICONS = [["badge", "Verified badge"], ["wallet", "Wallet"], ["truck", "Delivery truck"], ["return", "Return arrow"], ["shield", "Shield"], ["gift", "Gift"], ["support", "Headset"], ["check", "Tick"]];
const SOURCES = [["deals", "Biggest discounts"], ["bestsellers", "Bestsellers"], ["new", "Newest"], ["top_rated", "Top rated"], ["category", "From one category"], ["manual", "Products I pick"]];

const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

function flatten(nodes: CategoryNode[], prefix = ""): { slug: string; label: string }[] {
  return nodes.flatMap((n) => [{ slug: n.slug, label: prefix + n.name }, ...flatten(n.children ?? [], `${prefix}${n.name} › `)]);
}

function Slide({ v, onChange, onRemove }: { v: any; onChange: (v: any) => void; onRemove?: () => void }) {
  return (
    <div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><ImageField label="Image" value={v.image} onChange={(u) => onChange({ ...v, image: u })} hint="Keep words out of the image; add them below so they stay sharp on phones" /></div>
      <TextField label="Heading" value={v.heading} maxLength={80} onChange={(e) => onChange({ ...v, heading: e.target.value })} />
      <TextField label="Short text" value={v.text} maxLength={160} onChange={(e) => onChange({ ...v, text: e.target.value })} />
      <TextField label="Button text" value={v.cta} maxLength={30} onChange={(e) => onChange({ ...v, cta: e.target.value })} />
      <TextField label="Link" value={v.link} placeholder="/c/fashion or /search?q=saree" onChange={(e) => onChange({ ...v, link: e.target.value })} />
      {onRemove && <Button type="button" size="sm" variant="ghost" className="self-start" onClick={onRemove}><Trash2 className="h-4 w-4" /> Remove</Button>}
    </div>
  );
}

function ProductPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ProductCard[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => api<{ items: ProductCard[] }>("/api/catalog/products", { query: { q, page_size: 8 } }).then((r) => setResults(r.items)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="sm:col-span-2">
      <p className="mb-1 font-medium">Products ({ids.length} of 24)</p>
      <ul className="mb-2 flex flex-wrap gap-2">
        {ids.map((id) => (
          <li key={id} className="flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-sm">
            <span className="max-w-[220px] truncate">{picked[id] ?? `Product ${id.slice(0, 8)}`}</span>
            <button type="button" aria-label="Remove" className="rounded-full p-0.5 hover:bg-white" onClick={() => onChange(ids.filter((x) => x !== id))}><Trash2 className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
      <Input placeholder="Search live products to add" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" />
      {results.length > 0 && (
        <ul className="mt-1 max-h-56 overflow-auto rounded-lg border border-line">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={ids.includes(p.id) || ids.length >= 24} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist disabled:opacity-40" onClick={() => { setPicked({ ...picked, [p.id]: p.title }); onChange([...ids, p.id]); }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.image} alt="" className="h-8 w-8 rounded object-cover" />
                <span className="flex-1 truncate">{p.title}</span>
                <Plus className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConfigEditor({ kind, c, set, cats }: { kind: string; c: Record<string, any>; set: (c: Record<string, any>) => void; cats: { slug: string; label: string }[] }) {
  if (kind === "hero")
    return (
      <div className="flex flex-col gap-3">
        {(c.slides ?? []).map((s: any, i: number) => (
          <Slide key={i} v={s} onChange={(v) => set({ ...c, slides: c.slides.map((x: any, j: number) => (j === i ? v : x)) })} onRemove={c.slides.length > 1 ? () => set({ ...c, slides: c.slides.filter((_: any, j: number) => j !== i) }) : undefined} />
        ))}
        {(c.slides ?? []).length < 8 && <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => set({ ...c, slides: [...(c.slides ?? []), { ...STARTER.hero.slides[0] }] })}><Plus className="h-4 w-4" /> Add slide</Button>}
        <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={c.autoplay !== false} onChange={(e) => set({ ...c, autoplay: e.target.checked })} /> Move to the next slide automatically</label>
      </div>
    );
  if (kind === "banner") return <Slide v={c} onChange={set} />;
  if (kind === "banner_grid")
    return (
      <div className="flex flex-col gap-3">
        {(c.items ?? []).map((s: any, i: number) => (
          <Slide key={i} v={s} onChange={(v) => set({ ...c, items: c.items.map((x: any, j: number) => (j === i ? v : x)) })} onRemove={c.items.length > 2 ? () => set({ ...c, items: c.items.filter((_: any, j: number) => j !== i) }) : undefined} />
        ))}
        {(c.items ?? []).length < 4 && <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => set({ ...c, items: [...c.items, { ...STARTER.banner }] })}><Plus className="h-4 w-4" /> Add banner</Button>}
      </div>
    );
  if (kind === "products")
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Show" htmlFor="src"><Select id="src" value={c.source} onChange={(e) => set({ ...c, source: e.target.value })}>{SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Layout" htmlFor="lay"><Select id="lay" value={c.layout} onChange={(e) => set({ ...c, layout: e.target.value })}><option value="row">Scrolling row</option><option value="grid">Grid</option></Select></Field>
        <TextField label="How many (4 to 24)" inputMode="numeric" value={String(c.limit ?? 12)} onChange={(e) => set({ ...c, limit: Number(e.target.value.replace(/\D/g, "")) || 4 })} />
        {c.source === "category" && (
          <Field label="Category" htmlFor="pcat"><Select id="pcat" value={c.category_slug ?? ""} onChange={(e) => set({ ...c, category_slug: e.target.value })}><option value="">Choose</option>{cats.map((x) => <option key={x.slug} value={x.slug}>{x.label}</option>)}</Select></Field>
        )}
        {c.source === "manual" && <ProductPicker ids={c.product_ids ?? []} onChange={(ids) => set({ ...c, product_ids: ids })} />}
      </div>
    );
  if (kind === "categories")
    return (
      <div className="flex flex-col gap-3">
        <Field label="Style" htmlFor="cst" className="max-w-xs"><Select id="cst" value={c.style} onChange={(e) => set({ ...c, style: e.target.value })}><option value="tiles">Picture tiles</option><option value="chips">Small chips</option></Select></Field>
        <p className="text-sm text-ink-soft">Tick the categories to show, in the order you tick them. Leave all unticked to show the main categories.</p>
        <div className="grid max-h-64 gap-1 overflow-auto rounded-lg border border-line p-2 sm:grid-cols-2">
          {cats.map((x) => {
            const on = (c.slugs ?? []).includes(x.slug);
            return (
              <label key={x.slug} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-peacock" checked={on} onChange={() => set({ ...c, slugs: on ? c.slugs.filter((s: string) => s !== x.slug) : [...(c.slugs ?? []), x.slug].slice(0, 16) })} />
                {x.label}{on && <span className="text-xs text-ink-faint">#{c.slugs.indexOf(x.slug) + 1}</span>}
              </label>
            );
          })}
        </div>
      </div>
    );
  if (kind === "text")
    return (
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <Textarea rows={10} value={c.markdown} onChange={(e) => set({ ...c, markdown: e.target.value })} aria-label="Text" className="font-mono text-sm" />
          <p className="mt-1 text-xs text-ink-faint">## Heading, **bold**, *italic*, - list item, [link text](/pages/about)</p>
          <Field label="Alignment" htmlFor="al" className="mt-2 max-w-xs"><Select id="al" value={c.align} onChange={(e) => set({ ...c, align: e.target.value })}><option value="left">Left</option><option value="center">Centre</option></Select></Field>
        </div>
        <div className={`rounded-lg border border-line p-3 ${c.align === "center" ? "text-center" : ""}`}><Markdown source={c.markdown ?? ""} /></div>
      </div>
    );
  if (kind === "usp")
    return (
      <div className="flex flex-col gap-2">
        {(c.items ?? []).map((it: any, i: number) => (
          <div key={i} className="flex items-center gap-2">
            <Select value={it.icon} onChange={(e) => set({ ...c, items: c.items.map((x: any, j: number) => (j === i ? { ...x, icon: e.target.value } : x)) })} className="w-44" aria-label="Icon">{ICONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Input value={it.text} maxLength={80} onChange={(e) => set({ ...c, items: c.items.map((x: any, j: number) => (j === i ? { ...x, text: e.target.value } : x)) })} aria-label="Text" />
            <button type="button" aria-label="Remove" className="rounded p-1.5 text-vermilion hover:bg-mist" onClick={() => set({ ...c, items: c.items.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {(c.items ?? []).length < 6 && <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => set({ ...c, items: [...(c.items ?? []), { icon: "check", text: "" }] })}><Plus className="h-4 w-4" /> Add promise</Button>}
      </div>
    );
  return <p className="text-ink-soft">This section has no settings. It shows the products each shopper viewed recently.</p>;
}

export function SectionsEditor() {
  const toast = useToast();
  const [now] = useState(() => Date.now());
  const [data, setData] = useState<{ kinds: Record<string, string>; items: Section[] } | null>(null);
  const [cats, setCats] = useState<{ slug: string; label: string }[]>([]);
  const [edit, setEdit] = useState<Section | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<typeof data>("/api/admin/storefront/sections").then(setData).catch(quietly), []);
  useEffect(() => {
    load();
    api<CategoryNode[]>("/api/catalog/categories").then((t) => setCats(flatten(t))).catch(() => {});
  }, [load]);

  async function reorder(items: Section[]) {
    setData((d) => (d ? { ...d, items } : d));
    await api("/api/admin/storefront/sections-order", { method: "PUT", body: { ids: items.map((s) => s.id) } });
  }
  function move(i: number, d: number) {
    if (!data) return;
    const n = [...data.items];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    reorder(n);
  }
  async function save(s: Section) {
    setError(null);
    const body = { kind: s.kind, title: s.title, config: s.config, is_active: s.is_active, device: s.device, starts_at: s.starts_at, ends_at: s.ends_at };
    try {
      if (s.id === "new") await api("/api/admin/storefront/sections", { method: "POST", body });
      else await api(`/api/admin/storefront/sections/${s.id}`, { method: "PUT", body });
      toast("Section saved. The home page updates within 15 seconds.");
      setEdit(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  }
  async function toggle(s: Section) {
    await api(`/api/admin/storefront/sections/${s.id}`, { method: "PUT", body: { ...s, is_active: !s.is_active } });
    load();
  }

  if (!data) return <PageLoader />;
  return (
    <div className="max-w-4xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-ink-soft">The home page shows these sections from top to bottom.</p>
        <div className="flex gap-2">
          <a href="/" target="_blank" rel="noreferrer" className="inline-flex h-10 items-center rounded-lg border border-line bg-white px-4 font-semibold">View shop</a>
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add section</Button>
        </div>
      </div>
      <ol className="flex flex-col gap-2">
        {data.items.map((s, i) => {
          const scheduled = s.starts_at && new Date(s.starts_at).getTime() > now;
          const ended = s.ends_at && new Date(s.ends_at).getTime() < now;
          return (
            <li key={s.id} className={`flex items-center gap-3 rounded-xl bg-white p-3 ${s.is_active ? "" : "opacity-60"}`}>
              <div className="flex flex-col">
                <button aria-label="Move up" disabled={i === 0} className="rounded p-1 hover:bg-mist disabled:opacity-30" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></button>
                <button aria-label="Move down" disabled={i === data.items.length - 1} className="rounded p-1 hover:bg-mist disabled:opacity-30" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></button>
              </div>
              <button className="flex-1 text-left" onClick={() => { setError(null); setEdit(s); }}>
                <p className="font-semibold">{s.title || s.kind_label}</p>
                <p className="text-sm text-ink-soft">
                  {s.kind_label}
                  {s.kind === "products" && `: ${SOURCES.find(([v]) => v === s.config.source)?.[1] ?? ""}`}
                  {s.kind === "hero" && `: ${s.config.slides?.length ?? 0} slides`}
                </p>
              </button>
              {s.device !== "all" && (s.device === "mobile" ? <Smartphone className="h-4 w-4 text-ink-faint" aria-label="Phones only" /> : <Monitor className="h-4 w-4 text-ink-faint" aria-label="Computers only" />)}
              {scheduled && <Pill tone="blue">From {date(s.starts_at)}</Pill>}
              {ended && <Pill tone="red">Ended</Pill>}
              <button aria-label={s.is_active ? "Hide section" : "Show section"} title={s.is_active ? "Hide" : "Show"} className="rounded p-2 hover:bg-mist" onClick={() => toggle(s)}>
                {s.is_active ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </button>
              <Button size="sm" variant="ghost" onClick={() => { setError(null); setEdit(s); }}>Edit</Button>
            </li>
          );
        })}
      </ol>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a section" wide>
        <ul className="grid gap-2 sm:grid-cols-2">
          {Object.entries(data.kinds).map(([k, label]) => (
            <li key={k}>
              <button className="h-full w-full rounded-lg border border-line p-3 text-left hover:border-peacock hover:bg-peacock-light" onClick={() => { setAdding(false); setError(null); setEdit({ id: "new", kind: k, kind_label: label, title: k === "usp" || k === "hero" || k === "text" || k === "banner" ? "" : label, config: structuredClone(STARTER[k]), is_active: true, device: "all", starts_at: null, ends_at: null }); }}>
                <p className="font-semibold">{label}</p>
                <p className="text-sm text-ink-soft">{KIND_HELP[k]}</p>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${edit.id === "new" ? "New" : "Edit"}: ${edit.kind_label}` : ""} wide>
        {edit && (
          <div className="flex flex-col gap-4">
            <ErrorNote message={error} />
            <TextField label="Heading shown above the section (optional)" value={edit.title} maxLength={120} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            <ConfigEditor kind={edit.kind} c={edit.config} set={(c) => setEdit({ ...edit, config: c })} cats={cats} />
            <div className="grid gap-3 rounded-lg bg-mist p-3 sm:grid-cols-3">
              <Field label="Show on" htmlFor="dev"><Select id="dev" value={edit.device} onChange={(e) => setEdit({ ...edit, device: e.target.value as Section["device"] })}><option value="all">Phones and computers</option><option value="mobile">Phones only</option><option value="desktop">Computers only</option></Select></Field>
              <TextField label="Show from (optional)" type="datetime-local" value={toLocal(edit.starts_at)} onChange={(e) => setEdit({ ...edit, starts_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
              <TextField label="Hide after (optional)" type="datetime-local" value={toLocal(edit.ends_at)} onChange={(e) => setEdit({ ...edit, ends_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
              <label className="flex items-center gap-2 sm:col-span-3"><input type="checkbox" className="accent-peacock" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Section is visible</label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save(edit)}>Save section</Button>
              {edit.id !== "new" && (
                <Button variant="danger" onClick={async () => { if (!confirmDelete()) return; await api(`/api/admin/storefront/sections/${edit.id}`, { method: "DELETE" }); setEdit(null); toast("Section removed"); load(); }}>
                  <Trash2 className="h-4 w-4" /> Delete section
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// Deleting is the only irreversible action here; a native confirm keeps it simple and keyboard-friendly.
function confirmDelete() {
  return typeof window !== "undefined" && window.confirm("Delete this section? You can add it again later, but its settings are lost.");
}
