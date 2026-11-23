/* Social links, contact details and the copyright line. Port of components/social.tsx. */

import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { AtSign, Clock, Facebook, Globe, Instagram, Link2, Linkedin, Mail, MapPin, MessageCircle, Phone, Pin, Send, Youtube, type LucideIconData } from "lucide-angular";
import type { ContactItem, SocialLink } from "../../core/types";
import { Icon } from "../ui/icon";

const ICONS: Record<string, LucideIconData> = { instagram: Instagram, facebook: Facebook, youtube: Youtube, linkedin: Linkedin, whatsapp: MessageCircle, telegram: Send, pinterest: Pin, threads: AtSign, website: Globe };

@Component({
  selector: "pc-social-glyph",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (link().icon === "custom") {
      @if (link().icon_url) {<img [src]="link().icon_url" alt="" [class]="cls() + ' rounded object-contain'" />}
      @else {<svg [pcIcon]="Globe" [class]="cls()" />}
    } @else if (link().icon === "x") {
      <svg viewBox="0 0 24 24" [class]="cls()" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 4l14 16M19 4L5 20" /></svg>
    } @else {
      <svg [pcIcon]="icon()" [class]="cls()" />
    }
  `,
})
export class SocialGlyph {
  readonly link = input.required<Pick<SocialLink, "icon" | "icon_url">>();
  readonly cls = input("h-5 w-5", { alias: "iconClass" });
  protected readonly Globe = Globe;
  protected readonly icon = computed(() => ICONS[this.link().icon] ?? Globe);
}

/** Social icons as links. Only enabled links with a URL are shown. */
@Component({
  selector: "pc-social-links",
  imports: [SocialGlyph],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (shown().length) {
      <ul [class]="'flex flex-wrap gap-2 ' + extra()">
        @for (l of shown(); track l.id) {
          <li>
            <a [href]="l.url" target="_blank" rel="noopener noreferrer nofollow" [attr.aria-label]="l.label + ' (opens in a new tab)'" [title]="l.label"
              [class]="'flex h-9 w-9 items-center justify-center rounded-full transition-colors ' + (tone() === 'light' ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-peacock-light text-peacock hover:bg-peacock hover:text-white')">
              <pc-social-glyph [link]="l" [iconClass]="iconClass()" />
            </a>
          </li>
        }
      </ul>
    }
  `,
})
export class SocialLinks {
  readonly links = input.required<SocialLink[]>();
  readonly extra = input("", { alias: "listClass" });
  readonly iconClass = input("h-5 w-5");
  readonly tone = input<"light" | "dark">("light");
  protected readonly shown = computed(() => this.links().filter((l) => l.enabled && l.url));
}

const CONTACT_ICON: Record<string, LucideIconData> = { email: Mail, phone: Phone, whatsapp: MessageCircle, address: MapPin, link: Link2, text: Clock };

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

@Component({
  selector: "pc-contact-list",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (shown().length) {
      <ul class="flex flex-col gap-2">
        @for (it of shown(); track it.id) {
          <li class="flex items-start gap-2">
            <svg [pcIcon]="icon(it)" [class]="'mt-0.5 h-4 w-4 shrink-0 ' + (tone() === 'light' ? 'text-white/60' : 'text-peacock')" />
            <span>
              @if (it.type !== "link") {<span [class]="tone() === 'light' ? 'block text-xs text-white/60' : 'block text-xs text-ink-faint'">{{ it.label }}</span>}
              @if (href(it); as h) {
                <a [href]="h" [attr.target]="external(h) ? '_blank' : null" [attr.rel]="external(h) ? 'noopener noreferrer' : null"
                  [class]="tone() === 'light' ? 'hover:text-white' : 'font-medium text-peacock hover:underline'">{{ it.type === "link" ? it.label : it.value }}</a>
              } @else {
                <span class="whitespace-pre-line">{{ it.type === "link" ? it.label : it.value }}</span>
              }
            </span>
          </li>
        }
      </ul>
    }
  `,
})
export class ContactList {
  readonly items = input.required<ContactItem[]>();
  readonly tone = input<"light" | "dark">("light");
  protected readonly shown = computed(() => this.items().filter((i) => i.enabled && i.value));
  protected readonly href = contactHref;
  protected icon(it: ContactItem) {
    return CONTACT_ICON[it.type] ?? Link2;
  }
  protected external(h: string) {
    return h.startsWith("https://");
  }
}

/** Replaces the copyright placeholders; plain text only, so nothing here is rendered as HTML. */
export function fillCopyright(template: string, vars: { legal_name: string; brand: string }) {
  return template.replaceAll("{year}", String(new Date().getFullYear())).replaceAll("{legal_name}", vars.legal_name).replaceAll("{brand}", vars.brand);
}
