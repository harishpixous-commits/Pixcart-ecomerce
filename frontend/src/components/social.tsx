"use client";

import { AtSign, Clock, Facebook, Globe, Instagram, Link2, Linkedin, Mail, MapPin, MessageCircle, Phone, Pin, Send, Youtube } from "lucide-react";
import type { ContactItem, SocialLink } from "@/lib/types";

function XGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
      <path d="M5 4l14 16M19 4L5 20" />
    </svg>
  );
}

const ICONS = { instagram: Instagram, facebook: Facebook, youtube: Youtube, linkedin: Linkedin, whatsapp: MessageCircle, telegram: Send, pinterest: Pin, threads: AtSign, website: Globe } as const;

export function SocialGlyph({ link, className = "h-5 w-5" }: { link: Pick<SocialLink, "icon" | "icon_url">; className?: string }) {
  if (link.icon === "custom") {
    return link.icon_url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={link.icon_url} alt="" className={`${className} rounded object-contain`} />
    ) : <Globe className={className} aria-hidden />;
  }
  if (link.icon === "x") return <XGlyph className={className} />;
  const Icon = ICONS[link.icon] ?? Globe;
  return <Icon className={className} aria-hidden />;
}

/** Social icons as links. Only enabled links with a URL are shown. */
export function SocialLinks({ links, className = "", iconClass = "h-5 w-5", tone = "light" }: { links: SocialLink[]; className?: string; iconClass?: string; tone?: "light" | "dark" }) {
  const shown = links.filter((l) => l.enabled && l.url);
  if (!shown.length) return null;
  return (
    <ul className={`flex flex-wrap gap-2 ${className}`}>
      {shown.map((l) => (
        <li key={l.id}>
          <a
            href={l.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            aria-label={`${l.label} (opens in a new tab)`}
            title={l.label}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${tone === "light" ? "bg-white/10 text-white hover:bg-white/20" : "bg-peacock-light text-peacock hover:bg-peacock hover:text-white"}`}
          >
            <SocialGlyph link={l} className={iconClass} />
          </a>
        </li>
      ))}
    </ul>
  );
}

const CONTACT_ICON = { email: Mail, phone: Phone, whatsapp: MessageCircle, address: MapPin, link: Link2, text: Clock } as const;

/** A safe link for a contact detail; values are validated by the API, digits are re-extracted here. */
export function contactHref(it: ContactItem): string | null {
  const digits = it.value.replace(/[^\d+]/g, "");
  switch (it.type) {
    case "email": return `mailto:${it.value}`;
    case "phone": return `tel:${digits}`;
    case "whatsapp": return `https://wa.me/${digits.replace(/^\+/, "").replace(/^(?=\d{10}$)/, "91")}`;
    case "link": return it.value.startsWith("/") || it.value.startsWith("https://") ? it.value : null;
    default: return null;
  }
}

export function ContactList({ items, tone = "light" }: { items: ContactItem[]; tone?: "light" | "dark" }) {
  const shown = items.filter((i) => i.enabled && i.value);
  if (!shown.length) return null;
  return (
    <ul className="flex flex-col gap-2">
      {shown.map((it) => {
        const Icon = CONTACT_ICON[it.type] ?? Link2;
        const href = contactHref(it);
        const external = href?.startsWith("https://");
        const value = it.type === "link" ? it.label : it.value;
        return (
          <li key={it.id} className="flex items-start gap-2">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "light" ? "text-white/60" : "text-peacock"}`} aria-hidden />
            <span>
              {it.type !== "link" && <span className={tone === "light" ? "block text-xs text-white/60" : "block text-xs text-ink-faint"}>{it.label}</span>}
              {href ? (
                <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} className={tone === "light" ? "hover:text-white" : "font-medium text-peacock hover:underline"}>{value}</a>
              ) : (
                <span className="whitespace-pre-line">{value}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Replaces the copyright placeholders; plain text only, so nothing here is rendered as HTML. */
export function fillCopyright(template: string, vars: { legal_name: string; brand: string }) {
  return template.replaceAll("{year}", String(new Date().getFullYear())).replaceAll("{legal_name}", vars.legal_name).replaceAll("{brand}", vars.brand);
}
