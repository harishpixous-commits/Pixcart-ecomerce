/*
 * Pieces shared by the admin's delivery pages: status pills, partner avatar, number tiles and the private document
 * viewer. Port of components/delivery/admin.tsx:
 *   <pc-kyc-pill [status] [active] />   <pc-online-dot [online] />   <pc-partner-avatar [p] size="sm|md|lg" />
 *   <pc-kpi [icon] label value hint tone href [alert] [pulse] testId />   <pc-partner-stars [value] [count] />
 *   <pc-doc-viewer [path] [title] (close) />
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, booleanAttribute, computed, effect, inject, input, output, signal } from "@angular/core";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { FileText, Loader2, Star, type LucideIconData } from "lucide-angular";
import { downloadBlob } from "../../core/api";
import type { KycStatus } from "../../core/delivery-types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Modal, Pill, type PillTone } from "../../shared/ui/ui";

const KYC: Record<KycStatus, { label: string; tone: PillTone }> = {
  draft: { label: "Not submitted", tone: "gray" },
  submitted: { label: "Waiting for review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  rejected: { label: "Needs changes", tone: "red" },
};

@Component({
  selector: "pc-kyc-pill",
  imports: [Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (!active()) {<pc-pill tone="red">Switched off</pc-pill>} @else {<pc-pill [tone]="k().tone">{{ k().label }}</pc-pill>}`,
})
export class KycPill {
  readonly status = input.required<KycStatus>();
  readonly active = input(true);
  protected readonly k = computed(() => KYC[this.status()] ?? { label: this.status(), tone: "gray" as const });
}

@Component({
  selector: "pc-online-dot",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "online() ? 'inline-flex items-center gap-1.5 text-xs font-semibold text-leaf' : 'inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint'" },
  template: `<span [class]="online() ? 'h-2 w-2 rounded-full bg-leaf shadow-[0_0_0_3px_rgba(30,142,62,0.2)]' : 'h-2 w-2 rounded-full bg-line'"></span> {{ online() ? "Online" : "Offline" }}`,
})
export class OnlineDot {
  readonly online = input.required<boolean>();
}

@Component({
  selector: "pc-partner-avatar",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (p().photo) {
      <img [src]="p().photo" alt="" [class]="cls() + ' shrink-0 rounded-full object-cover ring-2 ring-white'" />
    } @else {
      <span [class]="cls() + ' flex shrink-0 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock'">{{ p().name.slice(0, 1).toUpperCase() }}</span>
    }
  `,
})
export class PartnerAvatar {
  readonly p = input.required<{ photo: string; name: string }>();
  readonly size = input<"sm" | "md" | "lg">("md");
  protected readonly cls = computed(() => (this.size() === "lg" ? "h-20 w-20 text-2xl" : this.size() === "sm" ? "h-9 w-9 text-sm" : "h-12 w-12 text-base"));
}

const KPI_TONE = {
  green: "bg-leaf-light text-leaf",
  blue: "bg-peacock-light text-peacock",
  amber: "bg-marigold-light text-marigold-dark",
  red: "bg-vermilion-light text-vermilion",
  gray: "bg-mist text-ink-soft",
};
export type KpiTone = keyof typeof KPI_TONE;

/** A number tile with an icon, for the delivery dashboards. `alert` paints it red (e.g. stuck trips). */
@Component({
  selector: "pc-kpi",
  imports: [Icon, PcLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #body>
      <span class="flex items-start justify-between gap-2">
        <span [class]="alert() ? 'text-sm font-medium text-vermilion' : 'text-sm font-medium text-ink-soft'">{{ label() }}</span>
        <span [class]="'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ' + (alert() ? tones.red : tones[tone()])">
          @if (pulse()) {<span class="absolute inset-0 animate-ping rounded-xl bg-leaf/25 motion-reduce:animate-none" aria-hidden="true"></span>}
          <svg [pcIcon]="icon()" class="relative h-5 w-5" />
        </span>
      </span>
      <span [class]="alert() ? 'font-display text-3xl font-bold leading-none text-vermilion' : 'font-display text-3xl font-bold leading-none text-ink'" [attr.data-testid]="testId() || null">{{ value() }}</span>
      @if (hint()) {<span class="text-xs text-ink-faint">{{ hint() }}</span>}
    </ng-template>
    @if (href()) {
      <a [pcLink]="href()!" [class]="cls() + ' transition hover:ring-peacock/30 hover:shadow-md'"><ng-container [ngTemplateOutlet]="body" /></a>
    } @else {
      <div [class]="cls()"><ng-container [ngTemplateOutlet]="body" /></div>
    }
  `,
})
export class Kpi {
  readonly icon = input.required<LucideIconData>();
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly hint = input<string | undefined>(undefined);
  readonly tone = input<KpiTone>("blue");
  readonly href = input<string | undefined>(undefined);
  readonly alert = input(false, { transform: booleanAttribute });
  readonly pulse = input(false, { transform: booleanAttribute });
  readonly testId = input<string | undefined>(undefined);
  protected readonly tones = KPI_TONE;
  protected readonly cls = computed(() => cx("flex min-w-0 flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1", this.alert() ? "ring-vermilion/40" : "ring-black/5"));
}

/** A partner's rating with its count (components/delivery/admin.tsx Stars). */
@Component({
  selector: "pc-partner-stars",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!count()) {
      <span class="text-xs text-ink-faint">No ratings yet</span>
    } @else {
      <span class="inline-flex items-center gap-1 text-sm font-semibold"><svg [pcIcon]="Star" class="h-4 w-4 fill-marigold text-marigold" /> {{ value().toFixed(1) }} <span class="font-normal text-ink-faint">({{ count() }})</span></span>
    }
  `,
})
export class PartnerStars {
  readonly value = input.required<number>();
  readonly count = input.required<number>();
  protected readonly Star = Star;
}

/** Opens a private file (KYC document or delivery proof) through the signed-in API and shows it in a modal. */
@Component({
  selector: "pc-doc-viewer",
  imports: [Modal, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="path() !== null" (close)="onClose()" [title]="title()" [wide]="true">
      @if (error()) {
        <p class="text-vermilion">{{ error() }}</p>
      } @else if (!shown()) {
        <div class="flex h-64 items-center justify-center text-ink-soft"><svg [pcIcon]="Loader2" class="h-6 w-6 animate-spin" /></div>
      } @else if (shown()!.type === "application/pdf") {
        <div class="flex flex-col gap-2">
          <iframe [src]="shown()!.safe" [title]="title()" class="h-[70vh] w-full rounded-lg ring-1 ring-line"></iframe>
          <a [href]="shown()!.safe" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-peacock"><svg [pcIcon]="FileText" class="h-4 w-4" /> Open in a new tab</a>
        </div>
      } @else {
        <img [src]="shown()!.safe" [alt]="title()" class="mx-auto max-h-[70vh] rounded-lg object-contain ring-1 ring-line" />
      }
    </pc-modal>
  `,
})
export class DocViewer {
  readonly path = input<string | null>(null);
  readonly title = input("");
  readonly close = output<void>();
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly Loader2 = Loader2;
  protected readonly FileText = FileText;
  private readonly file = signal<{ path: string; url: string; type: string; safe: SafeResourceUrl } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly shown = computed(() => {
    const f = this.file();
    return f && f.path === this.path() ? f : null;
  });

  constructor() {
    effect((onCleanup) => {
      const path = this.path();
      if (!path) return;
      let live = true;
      let url = "";
      downloadBlob(path).then((b) => {
        url = URL.createObjectURL(b);
        if (live) this.file.set({ path, url, type: b.type, safe: this.sanitizer.bypassSecurityTrustResourceUrl(url) });
      }).catch(() => {
        if (live) this.error.set("Could not open the file");
      });
      onCleanup(() => {
        live = false;
        if (url) URL.revokeObjectURL(url);
      });
    });
  }

  protected onClose(): void {
    this.file.set(null);
    this.error.set(null);
    this.close.emit();
  }
}
