"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { ImageField } from "@/components/media-picker";
import { Button, Field, Input, Select, Textarea, TextField } from "@/components/ui";
import type { LinkItem, Site } from "@/lib/types";

const COLOR_FIELDS: [keyof Site["colors"], string, string][] = [
  ["primary", "Main colour", "Header, links, main buttons"],
  ["primary_dark", "Main colour, dark", "Hover states and footer"],
  ["accent", "Highlight", "Announcement bar, ratings, badges"],
  ["buy", "Buy button", "Buy now, sale prices, errors"],
  ["success", "Success", "Discounts, in-stock, confirmations"],
  ["page", "Page background", "Behind the white cards"],
];

const PRESETS: { name: string; colors: Site["colors"] }[] = [
  { name: "Peacock", colors: { primary: "#0B5563", primary_dark: "#073B45", accent: "#F5A524", buy: "#D7263D", success: "#1E8E3E", page: "#EEF2F4" } },
  { name: "Indigo", colors: { primary: "#2E3A8C", primary_dark: "#1E2763", accent: "#FFB703", buy: "#E63946", success: "#2A9D8F", page: "#F1F2F8" } },
  { name: "Kanjivaram", colors: { primary: "#7A1F3D", primary_dark: "#54142A", accent: "#D4A017", buy: "#C2410C", success: "#15803D", page: "#F7F1EE" } },
  { name: "Banana leaf", colors: { primary: "#1F6F3F", primary_dark: "#14492A", accent: "#F2C14E", buy: "#D1495B", success: "#2D9A54", page: "#EFF4EE" } },
  { name: "Charcoal", colors: { primary: "#22303C", primary_dark: "#151E26", accent: "#FF8C42", buy: "#E4572E", success: "#3A9D5D", page: "#F0F1F2" } },
];

export function BrandEditor({ site, set }: { site: Site; set: (s: Site) => void }) {
  const c = site.colors;
  const radius = site.radius === "square" ? "4px" : site.radius === "soft" ? "10px" : "16px";
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-4">
        <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 className="text-lg font-semibold sm:col-span-2">Brand</h2>
          <TextField label="Store name" value={site.brand_name} maxLength={40} onChange={(e) => set({ ...site, brand_name: e.target.value })} />
          <TextField label="Tagline" value={site.tagline} maxLength={120} onChange={(e) => set({ ...site, tagline: e.target.value })} />
          <ImageField label="Logo" value={site.logo_url} onChange={(u) => set({ ...site, logo_url: u })} aspect="aspect-[3/1]" hint="Wide logo on a transparent background. Without a logo the store name is shown." />
          <ImageField label="Browser tab icon" value={site.favicon_url} onChange={(u) => set({ ...site, favicon_url: u })} aspect="aspect-square" hint="Square, at least 192 × 192" />
        </section>
        <section className="rounded-xl bg-white p-5">
          <h2 className="mb-1 text-lg font-semibold">Colours</h2>
          <p className="mb-3 text-sm text-ink-soft">Start from a preset, then adjust. Keep text readable: dark main colours work best with white text.</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" onClick={() => set({ ...site, colors: p.colors })} className="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-sm hover:border-peacock">
                <span className="flex overflow-hidden rounded-full">{[p.colors.primary, p.colors.accent, p.colors.buy].map((x) => <span key={x} className="h-5 w-3" style={{ background: x }} />)}</span>
                {p.name}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COLOR_FIELDS.map(([k, label, hint]) => (
              <div key={k}>
                <p className="font-medium">{label}</p>
                <div className="mt-1 flex items-center gap-2">
                  <input type="color" value={c[k]} onChange={(e) => set({ ...site, colors: { ...c, [k]: e.target.value.toUpperCase() } })} className="h-10 w-12 cursor-pointer rounded border border-line bg-white p-0.5" aria-label={label} />
                  <Input value={c[k]} onChange={(e) => set({ ...site, colors: { ...c, [k]: e.target.value } })} maxLength={7} className="font-mono uppercase" aria-label={`${label} hex`} />
                </div>
                <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>
              </div>
            ))}
          </div>
          <Field label="Corners" htmlFor="rad" className="mt-4 max-w-xs">
            <Select id="rad" value={site.radius} onChange={(e) => set({ ...site, radius: e.target.value as Site["radius"] })}>
              <option value="rounded">Rounded</option><option value="soft">Slightly rounded</option><option value="square">Square</option>
            </Select>
          </Field>
        </section>
        <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 className="text-lg font-semibold sm:col-span-2">Announcement bar</h2>
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="accent-peacock" checked={site.announcement.enabled} onChange={(e) => set({ ...site, announcement: { ...site.announcement, enabled: e.target.checked } })} /> Show the bar above the header</label>
          <TextField className="sm:col-span-2" label="Message" value={site.announcement.text} maxLength={160} onChange={(e) => set({ ...site, announcement: { ...site.announcement, text: e.target.value } })} />
          <TextField label="Link (optional)" value={site.announcement.link} placeholder="/search?sort=discount" onChange={(e) => set({ ...site, announcement: { ...site.announcement, link: e.target.value } })} />
          <Field label="Style" htmlFor="tone">
            <Select id="tone" value={site.announcement.tone} onChange={(e) => set({ ...site, announcement: { ...site.announcement, tone: e.target.value as Site["announcement"]["tone"] } })}>
              <option value="accent">Highlight colour</option><option value="primary">Main colour</option><option value="dark">Dark</option>
            </Select>
          </Field>
        </section>
        <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <h2 className="text-lg font-semibold sm:col-span-2">Search engines and tracking</h2>
          <TextField className="sm:col-span-2" label="Home page title" value={site.seo.title} maxLength={70} hint={`${site.seo.title.length} of 70 characters`} onChange={(e) => set({ ...site, seo: { ...site.seo, title: e.target.value } })} />
          <Field label="Home page description" className="sm:col-span-2" hint={`${site.seo.description.length} of 170 characters. Shown under your link in Google.`}>
            <Textarea rows={2} maxLength={170} value={site.seo.description} onChange={(e) => set({ ...site, seo: { ...site.seo, description: e.target.value } })} />
          </Field>
          <TextField label="Google Analytics ID" placeholder="G-XXXXXXXXXX" value={site.analytics.google_analytics_id} onChange={(e) => set({ ...site, analytics: { ...site.analytics, google_analytics_id: e.target.value.trim() } })} />
          <TextField label="Meta Pixel ID" placeholder="Numbers only" value={site.analytics.meta_pixel_id} onChange={(e) => set({ ...site, analytics: { ...site.analytics, meta_pixel_id: e.target.value.trim() } })} />
        </section>
      </div>
      {/* Live preview with the chosen colours */}
      <aside className="self-start xl:sticky xl:top-20">
        <p className="mb-2 text-sm font-semibold text-ink-soft">Preview</p>
        <div className="overflow-hidden rounded-xl border border-line shadow-sm" style={{ background: c.page }}>
          {site.announcement.enabled && (
            <div className="px-3 py-1.5 text-center text-xs font-semibold" style={{ background: site.announcement.tone === "accent" ? c.accent : site.announcement.tone === "primary" ? c.primary_dark : "#1f2933", color: site.announcement.tone === "accent" ? "#1f2933" : "#fff" }}>{site.announcement.text}</div>
          )}
          <div className="flex items-center gap-2 px-3 py-3" style={{ background: c.primary }}>
            {site.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={site.logo_url} alt="" className="h-7 max-w-[120px] object-contain" />
            ) : <span className="font-display text-xl font-bold text-white">{site.brand_name}</span>}
            <span className="ml-auto h-7 flex-1 rounded bg-white/95" style={{ borderRadius: radius }} />
          </div>
          <div className="p-3">
            <div className="bg-white p-3" style={{ borderRadius: radius }}>
              <div className="mb-2 aspect-square w-full" style={{ background: `${c.primary}22`, borderRadius: radius }} />
              <p className="text-sm font-medium text-ink">Cotton kurta, sky blue</p>
              <p className="text-xs" style={{ color: c.accent }}>★★★★☆ <span className="text-ink-faint">(128)</span></p>
              <p className="mt-1"><span className="font-bold">₹699</span> <span className="text-xs text-ink-faint line-through">₹1,299</span> <span className="text-xs font-semibold" style={{ color: c.success }}>46% off</span></p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <span className="py-2 text-center text-sm font-semibold text-white" style={{ background: c.primary, borderRadius: radius }}>Add to cart</span>
                <span className="py-2 text-center text-sm font-semibold text-white" style={{ background: c.buy, borderRadius: radius }}>Buy now</span>
              </div>
            </div>
          </div>
          <div className="px-3 py-3 text-xs text-white/80" style={{ background: c.primary_dark }}>{site.tagline}</div>
        </div>
      </aside>
    </div>
  );
}

function LinksEditor({ links, onChange, max }: { links: LinkItem[]; onChange: (l: LinkItem[]) => void; max: number }) {
  const move = (i: number, d: number) => {
    const n = [...links];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  return (
    <div className="flex flex-col gap-2">
      {links.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={l.label} placeholder="Label" maxLength={40} onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label="Link label" />
          <Input value={l.href} placeholder="/pages/about or https://" onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)))} aria-label="Link address" />
          <button type="button" aria-label="Move up" className="rounded p-1.5 hover:bg-mist" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></button>
          <button type="button" aria-label="Move down" className="rounded p-1.5 hover:bg-mist" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></button>
          <button type="button" aria-label="Remove link" className="rounded p-1.5 text-vermilion hover:bg-mist" onClick={() => onChange(links.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      {links.length < max && <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => onChange([...links, { label: "", href: "/" }])}><Plus className="h-4 w-4" /> Add link</Button>}
    </div>
  );
}

export function NavEditor({ site, set }: { site: Site; set: (s: Site) => void }) {
  const cols = site.footer_columns;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Header links</h2>
        <p className="mb-3 text-sm text-ink-soft">Shown next to the search box on large screens and in the menu on phones. Up to 6.</p>
        <LinksEditor links={site.header_links} max={6} onChange={(l) => set({ ...site, header_links: l })} />
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Footer</h2>
        <p className="mb-3 text-sm text-ink-soft">Up to 5 columns of links. Link to your own pages with /pages/page-address.</p>
        <div className="flex flex-col gap-4">
          {cols.map((col, i) => (
            <div key={i} className="rounded-lg border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <Input value={col.title} placeholder="Column title" maxLength={40} className="max-w-xs font-semibold" onChange={(e) => set({ ...site, footer_columns: cols.map((c, j) => (j === i ? { ...c, title: e.target.value } : c)) })} aria-label="Column title" />
                <Button type="button" size="sm" variant="ghost" onClick={() => set({ ...site, footer_columns: cols.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /> Remove column</Button>
              </div>
              <LinksEditor links={col.links} max={10} onChange={(l) => set({ ...site, footer_columns: cols.map((c, j) => (j === i ? { ...c, links: l } : c)) })} />
            </div>
          ))}
          {cols.length < 5 && <Button type="button" variant="secondary" className="self-start" onClick={() => set({ ...site, footer_columns: [...cols, { title: "New column", links: [] }] })}><Plus className="h-4 w-4" /> Add column</Button>}
        </div>
      </section>
    </div>
  );
}
