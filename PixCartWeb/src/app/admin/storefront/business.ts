/*
 * Admin → Storefront → Business, contact and social: the operator's legal details and grievance officer (Consumer
 * Protection (E-Commerce) Rules), contact details, social media links and what the footer shows.
 * Port of frontend/src/app/admin/storefront/business.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-angular";
import type { ContactItem, ContactType, Site, SocialIcon, SocialLink } from "../../core/types";
import { SocialGlyph } from "../../shared/chrome/social";
import { Icon } from "../../shared/ui/icon";
import { Button, Field, Input, Select, Textarea, TextField } from "../../shared/ui/ui";
import { ImageField } from "../shared/media-picker";

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

const FOOTER_FLAGS = [
  ["show_business", "Business name and registered address"],
  ["show_gstin", "GSTIN"],
  ["show_contact", "Contact details"],
  ["show_social", "Social media icons"],
  ["show_grievance", "Grievance officer"],
] as const;

function move<T>(list: T[], i: number, d: number): T[] {
  const n = [...list];
  const j = i + d;
  if (j < 0 || j >= n.length) return list;
  [n[i], n[j]] = [n[j], n[i]];
  return n;
}

const upperCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
const trim = (v: string) => v.trim();

/** Move up, move down, show or hide, remove. */
@Component({
  selector: "pc-row-tools",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center gap-0.5" },
  template: `
    <button type="button" [attr.aria-label]="'Move ' + label() + ' up'" [disabled]="i() === 0" class="rounded p-1.5 hover:bg-mist disabled:opacity-30" (click)="moved.emit(-1)"><svg [pcIcon]="ArrowUp" class="h-4 w-4" /></button>
    <button type="button" [attr.aria-label]="'Move ' + label() + ' down'" [disabled]="i() === count() - 1" class="rounded p-1.5 hover:bg-mist disabled:opacity-30" (click)="moved.emit(1)"><svg [pcIcon]="ArrowDown" class="h-4 w-4" /></button>
    <button type="button" [attr.aria-label]="enabled() ? 'Hide ' + label() : 'Show ' + label()" [attr.aria-pressed]="enabled()" [attr.title]="enabled() ? 'Shown on the site' : 'Hidden'" class="rounded p-1.5 hover:bg-mist" (click)="toggled.emit()">
      @if (enabled()) {<svg [pcIcon]="Eye" class="h-4 w-4 text-leaf" />} @else {<svg [pcIcon]="EyeOff" class="h-4 w-4 text-ink-faint" />}
    </button>
    <button type="button" [attr.aria-label]="'Remove ' + label()" class="rounded p-1.5 text-vermilion hover:bg-mist" (click)="removed.emit()"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
  `,
})
export class RowTools {
  readonly i = input.required<number>();
  readonly count = input.required<number>();
  readonly enabled = input.required<boolean>();
  readonly label = input.required<string>();
  readonly moved = output<number>();
  readonly toggled = output<void>();
  readonly removed = output<void>();
  protected readonly ArrowUp = ArrowUp;
  protected readonly ArrowDown = ArrowDown;
  protected readonly Eye = Eye;
  protected readonly EyeOff = EyeOff;
  protected readonly Trash2 = Trash2;
}

@Component({
  selector: "label[pcModuleSwitch]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-start gap-3 rounded-lg bg-mist p-3" },
  template: `
    <input type="checkbox" role="switch" [attr.aria-checked]="on()" class="mt-1 h-4 w-4 accent-peacock" [checked]="on()" (change)="onChange.emit($any($event.target).checked)" />
    <span><span class="font-semibold">{{ label() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
  `,
})
export class ModuleSwitch {
  readonly on = input.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly onChange = output<boolean>();
}

@Component({
  selector: "pc-business-editor",
  imports: [RowTools, ModuleSwitch, SocialGlyph, ImageField, TextField, Field, Input, Select, Textarea, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex max-w-4xl flex-col gap-4" },
  template: `
    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <div class="sm:col-span-2">
        <h2 class="text-lg font-semibold">Business details</h2>
        <p class="text-sm text-ink-soft">The Consumer Protection (E-Commerce) Rules require the operator's legal name, address and grievance officer on the site. These appear in the footer, on the grievance page, in emails and on invoices.</p>
      </div>
      <pc-text-field label="Registered business name" [value]="b().legal_name" maxlength="120" (valueChange)="setB({ legal_name: $event })" placeholder="Your Company Private Limited" />
      <pc-text-field label="GSTIN (e-commerce operator)" [value]="b().gstin" maxlength="15" [filter]="upperCode" (valueChange)="setB({ gstin: $event })" hint="Checked for a valid check digit" />
      <pc-field label="Registered address" class="sm:col-span-2" hint="Full postal address as on your incorporation or GST certificate">
        <textarea pcTextarea rows="2" maxlength="400" [value]="b().registered_address" (input)="setB({ registered_address: $any($event.target).value })"></textarea>
      </pc-field>
      <pc-text-field label="CIN (optional)" [value]="b().cin" maxlength="21" [filter]="upperCode" (valueChange)="setB({ cin: $event })" placeholder="U12345TN2024PTC123456" />
    </section>

    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <h2 class="text-lg font-semibold sm:col-span-2">Grievance officer</h2>
      <pc-text-field label="Name" [value]="g().name" maxlength="80" (valueChange)="setG({ name: $event })" />
      <pc-text-field label="Designation" [value]="g().designation" maxlength="60" (valueChange)="setG({ designation: $event })" />
      <pc-text-field label="Email" type="email" [value]="g().email" [filter]="trim" (valueChange)="setG({ email: $event })" />
      <pc-text-field label="Phone" [value]="g().phone" maxlength="20" (valueChange)="setG({ phone: $event })" />
      <pc-text-field class="sm:col-span-2" label="Hours" [value]="g().hours" maxlength="80" (valueChange)="setG({ hours: $event })" placeholder="Monday to Saturday, 10 am to 6 pm" />
    </section>

    <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
      <h2 class="text-lg font-semibold">Contact details</h2>
      <label pcModuleSwitch [on]="contact().enabled" (onChange)="set({ contact: { ...contact(), enabled: $event } })" label="Show contact details" hint="In the footer and on the Contact us page (/contact)."></label>
      <pc-text-field label="Heading" [value]="contact().title" maxlength="40" (valueChange)="set({ contact: { ...contact(), title: $event } })" />
      <ul class="flex flex-col gap-2">
        @for (it of contact().items; track it.id; let i = $index) {
          <li [class]="it.enabled ? 'grid items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[150px_1fr_1.6fr_auto] ' : 'grid items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[150px_1fr_1.6fr_auto] opacity-60'">
            <pc-field label="Type">
              <select pcSelect (change)="setItem(i, { type: $any($event.target).value })">
                @for (c of contactTypes; track c.type) {<option [value]="c.type" [selected]="c.type === it.type">{{ c.label }}</option>}
              </select>
            </pc-field>
            <pc-field label="Label"><input pcInput [value]="it.label" maxlength="40" (input)="setItem(i, { label: $any($event.target).value })" /></pc-field>
            <pc-field label="Value"><input pcInput [value]="it.value" maxlength="300" [placeholder]="typeOf(it).placeholder" (input)="setItem(i, { value: $any($event.target).value })" /></pc-field>
            <pc-row-tools [i]="i" [count]="contact().items.length" [enabled]="it.enabled" [label]="it.label || typeOf(it).label"
              (moved)="setItems(moveList(contact().items, i, $event))" (toggled)="setItem(i, { enabled: !it.enabled })" (removed)="setItems(withoutItem(i))" />
          </li>
        }
      </ul>
      @if (contact().items.length < 10) {
        <div class="flex flex-wrap gap-2">
          @for (c of contactTypes; track c.type) {
            <button pcButton type="button" size="sm" variant="ghost" (click)="addItem(c.type, c.label)">
              <svg [pcIcon]="Plus" class="h-4 w-4" /> Add {{ c.label.toLowerCase() }}
            </button>
          }
        </div>
      }
    </section>

    <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
      <h2 class="text-lg font-semibold">Social media</h2>
      <label pcModuleSwitch [on]="social().enabled" (onChange)="set({ social: { ...social(), enabled: $event } })" label="Show social media links" hint="Icons in the footer and on the Contact us page; also told to search engines."></label>
      <pc-text-field label="Heading" [value]="social().title" maxlength="40" (valueChange)="set({ social: { ...social(), title: $event } })" />
      <ul class="flex flex-col gap-2">
        @for (l of social().links; track l.id; let i = $index) {
          <li [class]="l.enabled ? 'flex flex-col gap-2 rounded-lg border border-line p-3 ' : 'flex flex-col gap-2 rounded-lg border border-line p-3 opacity-60'">
            <div class="grid items-end gap-2 sm:grid-cols-[auto_170px_1fr_1.6fr_auto]">
              <span class="flex h-10 w-10 items-center justify-center rounded-full bg-peacock text-white" aria-hidden="true"><pc-social-glyph [link]="l" iconClass="h-5 w-5" /></span>
              <pc-field label="Icon">
                <select pcSelect (change)="setIcon(i, l, $any($event.target).value)">
                  @for (p of presets; track p.icon) {<option [value]="p.icon" [selected]="p.icon === l.icon">{{ p.label }}</option>}
                </select>
              </pc-field>
              <pc-field label="Name shown"><input pcInput [value]="l.label" maxlength="40" (input)="setLink(i, { label: $any($event.target).value })" placeholder="e.g. ShareChat" /></pc-field>
              <pc-field label="Link"><input pcInput [value]="l.url" maxlength="300" [placeholder]="presetOf(l).placeholder" (input)="setLinkUrl(i, $event)" /></pc-field>
              <pc-row-tools [i]="i" [count]="social().links.length" [enabled]="l.enabled" [label]="l.label || presetOf(l).label"
                (moved)="setLinks(moveList(social().links, i, $event))" (toggled)="setLink(i, { enabled: !l.enabled })" (removed)="setLinks(withoutLink(i))" />
            </div>
            @if (l.icon === "custom") {<pc-image-field label="Icon image" [value]="l.icon_url" (valueChange)="setLink(i, { icon_url: $event })" aspect="aspect-square" hint="Square PNG or WebP, at least 64 × 64, on a transparent background" />}
          </li>
        }
      </ul>
      @if (social().links.length < 12) {
        <div class="flex flex-wrap gap-2">
          @for (p of addable(); track p.icon) {
            <button pcButton type="button" size="sm" variant="ghost" (click)="addLink(p)">
              <svg [pcIcon]="Plus" class="h-4 w-4" /> {{ p.icon === "custom" ? "Add another platform" : "Add " + p.label }}
            </button>
          }
        </div>
      }
    </section>

    <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
      <h2 class="text-lg font-semibold">Footer</h2>
      <div class="grid gap-2 sm:grid-cols-2">
        @for (x of footerFlags; track x[0]) {
          <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="f()[x[0]]" (change)="setFlag(x[0], $any($event.target).checked)" /> {{ x[1] }}</label>
        }
      </div>
      <pc-text-field label="Copyright line" [value]="f().copyright" maxlength="240" (valueChange)="set({ footer: { ...f(), copyright: $event } })" hint="You can use {year}, {legal_name} and {brand}; they are filled in automatically." />
      <p class="text-xs text-ink-faint">The grievance officer and registered address are legal requirements. Hide them only if you show them elsewhere on every page.</p>
    </section>
  `,
})
export class BusinessEditor {
  readonly site = input.required<Site>();
  readonly siteChange = output<Site>();
  protected readonly Plus = Plus;
  protected readonly presets = SOCIAL_PRESETS;
  protected readonly contactTypes = CONTACT_TYPES;
  protected readonly footerFlags = FOOTER_FLAGS;
  protected readonly upperCode = upperCode;
  protected readonly trim = trim;
  protected readonly moveList = move;
  protected readonly b = computed(() => this.site().business);
  protected readonly g = computed(() => this.b().grievance);
  protected readonly contact = computed(() => this.site().contact);
  protected readonly social = computed(() => this.site().social);
  protected readonly f = computed(() => this.site().footer);
  protected readonly addable = computed(() => SOCIAL_PRESETS.filter((p) => p.icon === "custom" || !this.social().links.some((l) => l.icon === p.icon)));

  protected set(p: Partial<Site>): void {
    this.siteChange.emit({ ...this.site(), ...p });
  }
  protected setB(p: Partial<Site["business"]>): void {
    this.set({ business: { ...this.b(), ...p } });
  }
  protected setG(p: Partial<Site["business"]["grievance"]>): void {
    this.setB({ grievance: { ...this.g(), ...p } });
  }
  protected setFlag(k: (typeof FOOTER_FLAGS)[number][0], v: boolean): void {
    this.set({ footer: { ...this.f(), [k]: v } });
  }
  protected typeOf(it: ContactItem): (typeof CONTACT_TYPES)[number] {
    return CONTACT_TYPES.find((x) => x.type === it.type) ?? CONTACT_TYPES[0];
  }
  protected presetOf(l: SocialLink): (typeof SOCIAL_PRESETS)[number] {
    return SOCIAL_PRESETS.find((p) => p.icon === l.icon) ?? SOCIAL_PRESETS[SOCIAL_PRESETS.length - 1];
  }
  protected setItems(items: ContactItem[]): void {
    this.set({ contact: { ...this.contact(), items } });
  }
  protected setItem(i: number, p: Partial<ContactItem>): void {
    this.setItems(this.contact().items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }
  protected withoutItem(i: number): ContactItem[] {
    return this.contact().items.filter((_, j) => j !== i);
  }
  protected addItem(type: ContactType, label: string): void {
    this.setItems([...this.contact().items, { id: newId(), type, label: type === "phone" ? "Customer care" : label, value: "", enabled: true }]);
  }
  protected setLinks(links: SocialLink[]): void {
    this.set({ social: { ...this.social(), links } });
  }
  protected setLink(i: number, p: Partial<SocialLink>): void {
    this.setLinks(this.social().links.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }
  protected setLinkUrl(i: number, e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.trim();
    if (v !== el.value) el.value = v;
    this.setLink(i, { url: v });
  }
  protected withoutLink(i: number): SocialLink[] {
    return this.social().links.filter((_, j) => j !== i);
  }
  protected setIcon(i: number, l: SocialLink, icon: SocialIcon): void {
    const p = SOCIAL_PRESETS.find((x) => x.icon === icon);
    // Keep a name the admin typed; replace one that only came from the previous preset.
    const typed = l.label && !SOCIAL_PRESETS.some((x) => x.label === l.label);
    this.setLink(i, { icon, label: typed ? l.label : icon === "custom" ? "" : (p?.label ?? "") });
  }
  protected addLink(p: (typeof SOCIAL_PRESETS)[number]): void {
    this.setLinks([...this.social().links, { id: newId(), icon: p.icon, label: p.icon === "custom" ? "" : p.label, url: "", icon_url: "", enabled: true }]);
  }
}
