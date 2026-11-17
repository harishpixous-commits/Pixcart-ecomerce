"use client";

import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { ImageField } from "@/components/media-picker";
import { SocialGlyph } from "@/components/social";
import { Button, Field, Input, Select, Textarea, TextField } from "@/components/ui";
import type { ContactItem, ContactType, Site, SocialIcon, SocialLink } from "@/lib/types";

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");

export const SOCIAL_PRESETS: { icon: SocialIcon; label: string; placeholder: string }[] = [
  { icon: "instagram", label: "Instagram", placeholder: "https://instagram.com/yourshop" },
  { icon: "facebook", label: "Facebook", placeholder: "https://facebook.com/yourshop" },
  { icon: "youtube", label: "YouTube", placeholder: "https://youtube.com/@yourshop" },
  { icon: "x", label: "X", placeholder: "https://x.com/yourshop" },
  { icon: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/company/yourshop" },
  { icon: "whatsapp", label: "WhatsApp", placeholder: "https://wa.me/919876543210" },
  { icon: "telegram", label: "Telegram", placeholder: "https://t.me/yourshop" },
  { icon: "pinterest", label: "Pinterest", placeholder: "https://pinterest.com/yourshop" },
  { icon: "threads", label: "Threads", placeholder: "https://threads.net/@yourshop" },
  { icon: "website", label: "Website", placeholder: "https://yourshop.in/blog" },
  { icon: "custom", label: "Other (upload an icon)", placeholder: "https://" },
];

const CONTACT_TYPES: { type: ContactType; label: string; placeholder: string }[] = [
  { type: "email", label: "Email", placeholder: "care@yourshop.in" },
  { type: "phone", label: "Phone", placeholder: "+91 44 4000 1234" },
  { type: "whatsapp", label: "WhatsApp", placeholder: "+91 98765 43210" },
  { type: "address", label: "Address", placeholder: "Shop or office address" },
  { type: "link", label: "Link", placeholder: "/pages/store-locator or https://maps.app.goo.gl/..." },
  { type: "text", label: "Note", placeholder: "Monday to Saturday, 10 am to 7 pm" },
];

function move<T>(list: T[], i: number, d: number): T[] {
  const n = [...list];
  const j = i + d;
  if (j < 0 || j >= n.length) return list;
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

function RowTools({ i, count, enabled, onMove, onToggle, onRemove, label }: { i: number; count: number; enabled: boolean; onMove: (d: number) => void; onToggle: () => void; onRemove: () => void; label: string }) {
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" aria-label={`Move ${label} up`} disabled={i === 0} className="rounded p-1.5 hover:bg-mist disabled:opacity-30" onClick={() => onMove(-1)}><ArrowUp className="h-4 w-4" /></button>
      <button type="button" aria-label={`Move ${label} down`} disabled={i === count - 1} className="rounded p-1.5 hover:bg-mist disabled:opacity-30" onClick={() => onMove(1)}><ArrowDown className="h-4 w-4" /></button>
      <button type="button" aria-label={enabled ? `Hide ${label}` : `Show ${label}`} aria-pressed={enabled} title={enabled ? "Shown on the site" : "Hidden"} className="rounded p-1.5 hover:bg-mist" onClick={onToggle}>
        {enabled ? <Eye className="h-4 w-4 text-leaf" /> : <EyeOff className="h-4 w-4 text-ink-faint" />}
      </button>
      <button type="button" aria-label={`Remove ${label}`} className="rounded p-1.5 text-vermilion hover:bg-mist" onClick={onRemove}><Trash2 className="h-4 w-4" /></button>
    </div>
  );
}

function ModuleSwitch({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 rounded-lg bg-mist p-3">
      <input type="checkbox" role="switch" aria-checked={on} className="mt-1 h-4 w-4 accent-peacock" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

export function BusinessEditor({ site, set }: { site: Site; set: (s: Site) => void }) {
  const b = site.business;
  const g = b.grievance;
  const setB = (patch: Partial<Site["business"]>) => set({ ...site, business: { ...b, ...patch } });
  const setG = (patch: Partial<Site["business"]["grievance"]>) => setB({ grievance: { ...g, ...patch } });
  const contact = site.contact;
  const social = site.social;
  const setItems = (items: ContactItem[]) => set({ ...site, contact: { ...contact, items } });
  const setLinks = (links: SocialLink[]) => set({ ...site, social: { ...social, links } });
  const f = site.footer;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <h2 className="text-lg font-semibold">Business details</h2>
          <p className="text-sm text-ink-soft">The Consumer Protection (E-Commerce) Rules require the operator&apos;s legal name, address and grievance officer on the site. These appear in the footer, on the grievance page, in emails and on invoices.</p>
        </div>
        <TextField label="Registered business name" value={b.legal_name} maxLength={120} onChange={(e) => setB({ legal_name: e.target.value })} placeholder="Your Company Private Limited" />
        <TextField label="GSTIN (e-commerce operator)" value={b.gstin} maxLength={15} onChange={(e) => setB({ gstin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} hint="Checked for a valid check digit" />
        <Field label="Registered address" className="sm:col-span-2" hint="Full postal address as on your incorporation or GST certificate">
          <Textarea rows={2} maxLength={400} value={b.registered_address} onChange={(e) => setB({ registered_address: e.target.value })} />
        </Field>
        <TextField label="CIN (optional)" value={b.cin} maxLength={21} onChange={(e) => setB({ cin: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="U12345TN2024PTC123456" />
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Grievance officer</h2>
        <TextField label="Name" value={g.name} maxLength={80} onChange={(e) => setG({ name: e.target.value })} />
        <TextField label="Designation" value={g.designation} maxLength={60} onChange={(e) => setG({ designation: e.target.value })} />
        <TextField label="Email" type="email" value={g.email} onChange={(e) => setG({ email: e.target.value.trim() })} />
        <TextField label="Phone" value={g.phone} maxLength={20} onChange={(e) => setG({ phone: e.target.value })} />
        <TextField className="sm:col-span-2" label="Hours" value={g.hours} maxLength={80} onChange={(e) => setG({ hours: e.target.value })} placeholder="Monday to Saturday, 10 am to 6 pm" />
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Contact details</h2>
        <ModuleSwitch on={contact.enabled} onChange={(v) => set({ ...site, contact: { ...contact, enabled: v } })} label="Show contact details" hint="In the footer and on the Contact us page (/contact)." />
        <TextField label="Heading" value={contact.title} maxLength={40} onChange={(e) => set({ ...site, contact: { ...contact, title: e.target.value } })} />
        <ul className="flex flex-col gap-2">
          {contact.items.map((it, i) => {
            const t = CONTACT_TYPES.find((x) => x.type === it.type) ?? CONTACT_TYPES[0];
            return (
              <li key={it.id} className={`grid items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[150px_1fr_1.6fr_auto] ${it.enabled ? "" : "opacity-60"}`}>
                <Field label="Type">
                  <Select value={it.type} onChange={(e) => setItems(contact.items.map((x, j) => (j === i ? { ...x, type: e.target.value as ContactType } : x)))}>
                    {CONTACT_TYPES.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
                  </Select>
                </Field>
                <Field label="Label"><Input value={it.label} maxLength={40} onChange={(e) => setItems(contact.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} /></Field>
                <Field label="Value"><Input value={it.value} maxLength={300} placeholder={t.placeholder} onChange={(e) => setItems(contact.items.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} /></Field>
                <RowTools i={i} count={contact.items.length} enabled={it.enabled} label={it.label || t.label}
                  onMove={(d) => setItems(move(contact.items, i, d))}
                  onToggle={() => setItems(contact.items.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))}
                  onRemove={() => setItems(contact.items.filter((_, j) => j !== i))} />
              </li>
            );
          })}
        </ul>
        {contact.items.length < 10 && (
          <div className="flex flex-wrap gap-2">
            {CONTACT_TYPES.map((c) => (
              <Button key={c.type} type="button" size="sm" variant="ghost" onClick={() => setItems([...contact.items, { id: newId(), type: c.type, label: c.type === "phone" ? "Customer care" : c.label, value: "", enabled: true }])}>
                <Plus className="h-4 w-4" /> Add {c.label.toLowerCase()}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Social media</h2>
        <ModuleSwitch on={social.enabled} onChange={(v) => set({ ...site, social: { ...social, enabled: v } })} label="Show social media links" hint="Icons in the footer and on the Contact us page; also told to search engines." />
        <TextField label="Heading" value={social.title} maxLength={40} onChange={(e) => set({ ...site, social: { ...social, title: e.target.value } })} />
        <ul className="flex flex-col gap-2">
          {social.links.map((l, i) => {
            const preset = SOCIAL_PRESETS.find((p) => p.icon === l.icon) ?? SOCIAL_PRESETS[SOCIAL_PRESETS.length - 1];
            const update = (patch: Partial<SocialLink>) => setLinks(social.links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <li key={l.id} className={`flex flex-col gap-2 rounded-lg border border-line p-3 ${l.enabled ? "" : "opacity-60"}`}>
                <div className="grid items-end gap-2 sm:grid-cols-[auto_170px_1fr_1.6fr_auto]">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-peacock text-white" aria-hidden><SocialGlyph link={l} className="h-5 w-5" /></span>
                  <Field label="Icon">
                    <Select value={l.icon} onChange={(e) => {
                      const icon = e.target.value as SocialIcon;
                      const p = SOCIAL_PRESETS.find((x) => x.icon === icon);
                      // Keep a name the admin typed; replace one that only came from the previous preset.
                      const typed = l.label && !SOCIAL_PRESETS.some((x) => x.label === l.label);
                      update({ icon, label: typed ? l.label : icon === "custom" ? "" : (p?.label ?? "") });
                    }}>
                      {SOCIAL_PRESETS.map((p) => <option key={p.icon} value={p.icon}>{p.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Name shown"><Input value={l.label} maxLength={40} onChange={(e) => update({ label: e.target.value })} placeholder="e.g. ShareChat" /></Field>
                  <Field label="Link"><Input value={l.url} maxLength={300} placeholder={preset.placeholder} onChange={(e) => update({ url: e.target.value.trim() })} /></Field>
                  <RowTools i={i} count={social.links.length} enabled={l.enabled} label={l.label || preset.label}
                    onMove={(d) => setLinks(move(social.links, i, d))} onToggle={() => update({ enabled: !l.enabled })}
                    onRemove={() => setLinks(social.links.filter((_, j) => j !== i))} />
                </div>
                {l.icon === "custom" && <ImageField label="Icon image" value={l.icon_url} onChange={(u) => update({ icon_url: u })} aspect="aspect-square" hint="Square PNG or WebP, at least 64 × 64, on a transparent background" />}
              </li>
            );
          })}
        </ul>
        {social.links.length < 12 && (
          <div className="flex flex-wrap gap-2">
            {SOCIAL_PRESETS.filter((p) => p.icon === "custom" || !social.links.some((l) => l.icon === p.icon)).map((p) => (
              <Button key={p.icon} type="button" size="sm" variant="ghost" onClick={() => setLinks([...social.links, { id: newId(), icon: p.icon, label: p.icon === "custom" ? "" : p.label, url: "", icon_url: "", enabled: true }])}>
                <Plus className="h-4 w-4" /> {p.icon === "custom" ? "Add another platform" : `Add ${p.label}`}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Footer</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ["show_business", "Business name and registered address"],
            ["show_gstin", "GSTIN"],
            ["show_contact", "Contact details"],
            ["show_social", "Social media icons"],
            ["show_grievance", "Grievance officer"],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={f[k]} onChange={(e) => set({ ...site, footer: { ...f, [k]: e.target.checked } })} /> {label}</label>
          ))}
        </div>
        <TextField label="Copyright line" value={f.copyright} maxLength={240} onChange={(e) => set({ ...site, footer: { ...f, copyright: e.target.value } })} hint="You can use {year}, {legal_name} and {brand}; they are filled in automatically." />
        <p className="text-xs text-ink-faint">The grievance officer and registered address are legal requirements. Hide them only if you show them elsewhere on every page.</p>
      </section>
    </div>
  );
}
