"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { ImageField } from "@/components/media-picker";
import { Button, Field, Input, Select, Textarea, TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
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
  const live = useSite(); // the free-delivery amount comes from Marketplace settings, not from this draft
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
            <div className="px-3 py-1.5 text-center text-xs font-semibold" style={{ background: site.announcement.tone === "accent" ? c.accent : site.announcement.tone === "primary" ? c.primary_dark : "#1f2933", color: site.announcement.tone === "accent" ? "#1f2933" : "#fff" }}>{fillTokens(site.announcement.text, { brand_name: site.brand_name, free_shipping_threshold_paise: live.free_shipping_threshold_paise })}</div>
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
  const [cols, setCols] = useState<{ slug: string; title: string }[]>([]);
  useEffect(() => { api<{ items: { slug: string; title: string }[] }>("/api/catalog/collections").then((r) => setCols(r.items)).catch(() => setCols([])); }, []);
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
      {links.length < max && cols.length > 0 && (
        <select className="self-start rounded-md border border-line bg-white px-2 py-1.5 text-sm" aria-label="Add a collection link" value="" onChange={(e) => { const c = cols.find((x) => x.slug === e.target.value); if (c) onChange([...links, { label: c.title.slice(0, 40), href: `/collections/${c.slug}` }]); }}>
          <option value="">Add a collection link...</option>
          {cols.map((c) => <option key={c.slug} value={c.slug}>{c.title}</option>)}
        </select>
      )}
    </div>
  );
}

function Check({ checked, onChange, label, hint, testid }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; testid?: string }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

function WordsEditor({ words, onChange, max }: { words: string[]; onChange: (w: string[]) => void; max: number }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-2">
        {words.map((w, i) => (
          <li key={`${w}-${i}`} className="flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-sm">
            <Input value={w} maxLength={40} onChange={(e) => onChange(words.map((x, j) => (j === i ? e.target.value : x)))} aria-label="Search words"
              className="h-7 w-36 border-0 bg-transparent px-0 focus:ring-0" />
            <button type="button" aria-label={`Remove ${w}`} className="rounded-full p-0.5 hover:bg-white" onClick={() => onChange(words.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
      {words.length < max && <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => onChange([...words, ""])}><Plus className="h-4 w-4" /> Add search</Button>}
    </div>
  );
}

export function NavEditor({ site, set }: { site: Site; set: (s: Site) => void }) {
  const cols = site.footer_columns;
  const nav = site.nav;
  const setNav = (n: Partial<Site["nav"]>) => set({ ...site, nav: { ...nav, ...n } });
  const extras = site.home_extras ?? { back_to_top: true, signin_prompt: true };
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <section className="rounded-xl bg-white p-5" data-testid="nav-editor">
        <h2 className="mb-1 text-lg font-semibold">Navigation bar</h2>
        <p className="mb-3 text-sm text-ink-soft">The bar under the search box: the All menu, the delivery PIN, your links and the main categories. On phones it scrolls sideways.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Check checked={nav.all_menu} onChange={(v) => setNav({ all_menu: v })} label="All menu" hint="A side menu with every category, the deal and bestseller lists, and help." testid="nav-all-menu" />
          <Check checked={nav.search_categories} onChange={(v) => setNav({ search_categories: v })} label="Category in search" hint="A department picker in front of the search box (large screens)." />
          <Check checked={nav.show_categories} onChange={(v) => setNav({ show_categories: v })} label="Categories in the bar" hint="Main categories after your links." />
        </div>
        <h3 className="mb-2 mt-4 font-semibold">Links in the bar (up to 12)</h3>
        <LinksEditor links={nav.links} max={12} onChange={(l) => setNav({ links: l })} />
        <h3 className="mb-2 mt-4 font-semibold">Promotion at the end of the bar</h3>
        <div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
          <label className="flex items-center gap-2 sm:pb-2.5"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={nav.promo.enabled} onChange={(e) => setNav({ promo: { ...nav.promo, enabled: e.target.checked } })} /> Show</label>
          <TextField label="Text" value={nav.promo.text} maxLength={60} placeholder="Diwali sale is live" onChange={(e) => setNav({ promo: { ...nav.promo, text: e.target.value } })} />
          <TextField label="Link (optional)" value={nav.promo.link} placeholder="/deals" onChange={(e) => setNav({ promo: { ...nav.promo, link: e.target.value } })} />
          <Field label="Colour">
            <Select value={nav.promo.tone} onChange={(e) => setNav({ promo: { ...nav.promo, tone: e.target.value as Site["nav"]["promo"]["tone"] } })}>
              <option value="accent">Highlight</option><option value="buy">Buy button</option><option value="primary">Main colour</option><option value="dark">Dark</option>
            </Select>
          </Field>
        </div>
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">All menu: extra links</h2>
        <p className="mb-3 text-sm text-ink-soft">Shown at the end of the All menu, after the categories. {"{brand}"} becomes your store name. Up to 10.</p>
        <LinksEditor links={nav.drawer_links} max={10} onChange={(l) => setNav({ drawer_links: l })} />
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Trending searches</h2>
        <p className="mb-3 text-sm text-ink-soft">Suggested when a shopper taps the empty search box, after their own recent searches. Up to 10.</p>
        <WordsEditor words={nav.trending} max={10} onChange={(w) => setNav({ trending: w })} />
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Header links</h2>
        <p className="mb-3 text-sm text-ink-soft">Shown next to the account menu on large screens and in the menu on phones, e.g. Become a seller. Up to 6.</p>
        <LinksEditor links={site.header_links} max={6} onChange={(l) => set({ ...site, header_links: l })} />
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">On every page</h2>
        <Check checked={extras.back_to_top} onChange={(v) => set({ ...site, home_extras: { ...extras, back_to_top: v } })} label="Back to top" hint="A button that appears after scrolling down a long page." />
        <Check checked={extras.signin_prompt} onChange={(v) => set({ ...site, home_extras: { ...extras, signin_prompt: v } })} label="Sign-in prompt" hint="Shows the home page's Sign-in prompt section to visitors who are not signed in. Off hides it everywhere." />
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
