/* Admin → one listing: review, approve, reject or take down; AI check; correct photos and videos. Port of frontend/src/app/admin/products/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { ArrowLeft, ArrowRight, ImagePlus, Sparkles, X } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import { pct, rupees } from "../../core/format";
import { SiteService } from "../../core/site";
import type { ProductVideo, SellerProduct } from "../../core/types";
import { PageHeader, Table } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Modal, Pill, StatusPill, Textarea, Toast } from "../../shared/ui/ui";
import { VideoEditor } from "../shared/video-editor";

const QUICK_REASONS = [
  "Images are blurry, watermarked or show another brand's logo",
  "Title does not describe the product accurately",
  "Prohibited or restricted item",
  "MRP looks inflated compared with the market price",
  "Wrong category or GST rate",
];

const MAX_PHOTOS = 8;

/** Staff can correct a listing's photos: add, remove, reorder (first = main), then save. */
@Component({
  selector: "pc-admin-photo-editor",
  imports: [Icon, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mb-5 block" },
  template: `
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold">Photos</h2>
      @if (dirty()) {
        <div class="flex gap-2">
          <button pcButton size="sm" variant="secondary" (click)="draft.set(images())" [disabled]="saving()">Discard</button>
          <button pcButton size="sm" (click)="save()" [loading]="saving()" [disabled]="!draft().length || uploading()">Save photos</button>
        </div>
      }
    </div>
    <pc-error-note [message]="error()" />
    <div class="flex flex-wrap gap-3">
      @for (src of draft(); track src; let i = $index) {
        <div class="relative h-40 w-40 overflow-hidden rounded-lg border border-line bg-white">
          <img [src]="src" [alt]="'Photo ' + (i + 1)" class="h-full w-full object-contain" />
          @if (i === 0) {<span class="absolute left-1 top-1 rounded bg-peacock px-1.5 text-xs font-semibold text-white">Main</span>}
          <div class="absolute inset-x-0 bottom-0 flex justify-between bg-white/90 p-0.5">
            <button type="button" (click)="move(i, -1)" aria-label="Move left" class="p-1 disabled:opacity-30" [disabled]="i === 0"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" /></button>
            <button type="button" (click)="remove(src)" aria-label="Remove photo" class="p-1 text-vermilion"><svg [pcIcon]="X" class="h-4 w-4" /></button>
            <button type="button" (click)="move(i, 1)" aria-label="Move right" class="p-1 disabled:opacity-30" [disabled]="i === draft().length - 1"><svg [pcIcon]="ArrowRight" class="h-4 w-4" /></button>
          </div>
        </div>
      }
      @if (draft().length < max) {
        <label class="flex h-40 w-40 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock hover:border-peacock">
          <svg [pcIcon]="ImagePlus" class="h-6 w-6" />
          {{ uploading() ? "Uploading" : "Add photos" }}
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only" [disabled]="uploading()" (change)="picked($event)" />
        </label>
      }
    </div>
    <p class="mt-2 text-sm text-ink-faint">Up to {{ max }} photos. The first one is the main photo. Changes go live when you save.</p>
  `,
})
export class AdminPhotoEditor {
  readonly productId = input.required<string>();
  readonly images = input.required<string[]>();
  readonly saved = output<SellerProduct>();
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly ArrowRight = ArrowRight;
  protected readonly ImagePlus = ImagePlus;
  protected readonly X = X;
  protected readonly max = MAX_PHOTOS;
  protected readonly draft = signal<string[]>([]);
  protected readonly uploading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly dirty = computed(() => this.draft().join("|") !== this.images().join("|"));

  constructor() {
    // the reference remounts this editor (key) when the saved photos change: start again from them
    effect(() => {
      const images = this.images();
      untracked(() => this.draft.set(images));
    });
  }

  protected picked(e: Event): void {
    const el = e.target as HTMLInputElement;
    if (el.files) void this.upload(Array.from(el.files));
    el.value = "";
  }

  private async upload(files: File[]): Promise<void> {
    this.uploading.set(true);
    this.error.set(null);
    try {
      for (const file of files.slice(0, MAX_PHOTOS - this.draft().length)) {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ url: string }>("/api/admin/products/images", { method: "POST", form });
        this.draft.update((cur) => [...cur, r.url]);
      }
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      this.uploading.set(false);
    }
  }

  protected remove(src: string): void {
    this.draft.update((d) => d.filter((x) => x !== src));
  }

  protected move(i: number, d: -1 | 1): void {
    const draft = this.draft();
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    this.draft.set(next);
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      this.saved.emit(await api<SellerProduct>(`/api/admin/products/${this.productId()}/images`, { method: "PUT", body: { images: this.draft() } }));
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save photos");
    } finally {
      this.saving.set(false);
    }
  }
}

/** Staff can add, retitle, reorder or remove a listing's videos. */
@Component({
  selector: "pc-admin-video-section",
  imports: [Button, ErrorNote, VideoEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mb-5 block" },
  template: `
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-lg font-semibold">Videos</h2>
      @if (dirty()) {
        <div class="flex gap-2">
          <button pcButton size="sm" variant="secondary" (click)="draft.set(videos())" [disabled]="saving()">Discard</button>
          <button pcButton size="sm" (click)="save()" [loading]="saving()">Save videos</button>
        </div>
      }
    </div>
    <pc-error-note [message]="error()" />
    <pc-video-editor [videos]="draft()" (videosChange)="draft.set($event)" videoUploadPath="/api/admin/products/videos" imageUploadPath="/api/admin/products/images"
      [maxVideos]="site.site().gallery?.max_videos ?? 3" [maxMb]="site.site().gallery?.max_video_mb ?? 50" />
  `,
})
export class AdminVideoSection {
  readonly productId = input.required<string>();
  readonly videos = input.required<ProductVideo[]>();
  readonly saved = output<SellerProduct>();
  protected readonly site = inject(SiteService);
  protected readonly draft = signal<ProductVideo[]>([]);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.videos()));

  constructor() {
    effect(() => {
      const videos = this.videos();
      untracked(() => this.draft.set(videos));
    });
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      this.saved.emit(await api<SellerProduct>(`/api/admin/products/${this.productId()}/videos`, { method: "PUT", body: { videos: this.draft() } }));
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save videos");
    } finally {
      this.saving.set(false);
    }
  }
}

type Check = { risk: "low" | "medium" | "high"; issues: string[]; suggested_reason: string };

@Component({
  selector: "pc-admin-products-id-page",
  imports: [PageHeader, Table, Icon, PcLink, PageLoader, Button, ErrorNote, Modal, Pill, StatusPill, Textarea, AdminPhotoEditor, AdminVideoSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!product()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let p = product()!;
      <div class="flex flex-col gap-4">
        <pc-page-header [title]="p.title" [sub]="subtitle(p)" [withActions]="true">
          @if (site.site().features.ai) {<button actions pcButton variant="secondary" (click)="runCheck()" [loading]="checking()"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> AI check</button>}
          @if (p.status === "pending") {<button actions pcButton (click)="act('approve')" [loading]="busy()">Approve</button>}
          @if (p.status === "pending" || p.status === "approved") {<button actions pcButton variant="danger" (click)="rejecting.set(true)">{{ p.status === "approved" ? "Take down" : "Reject" }}</button>}
          @if (p.status === "approved") {<a actions [pcLink]="'/p/' + p.slug" target="_blank" class="inline-flex h-10 items-center px-3 font-semibold text-peacock">View on store</a>}
        </pc-page-header>
        <pc-error-note [message]="error()" />
        <section class="flex flex-wrap items-end gap-3 rounded-xl bg-white p-5">
          <label class="text-sm font-semibold">Go live at
            <input type="datetime-local" class="ml-3 h-10 rounded-lg border border-black/15 px-3 font-normal" [value]="goLiveValue()" (input)="goLive.set($any($event.target).value)" data-testid="admin-publish-at" />
          </label>
          <button pcButton size="sm" [loading]="busy()" (click)="saveGoLive()">Save go-live time</button>
          <span class="text-sm text-ink-faint">Leave empty to go live as soon as approved.</span>
        </section>
        <section class="flex flex-wrap items-end gap-3 rounded-xl bg-white p-5">
          <label class="text-sm font-semibold">Most per order (each option)
            <input type="number" min="0" max="100" class="ml-3 h-10 w-24 rounded-lg border border-black/15 px-3 font-normal" [value]="unitLimitValue()" (input)="unitLimit.set($any($event.target).value)" data-testid="admin-unit-limit" />
          </label>
          <button pcButton size="sm" [loading]="busy()" (click)="saveUnitLimit()">Save limit</button>
          <span class="text-sm text-ink-faint">0 means no limit for this product. The store-wide limit still applies.</span>
        </section>
        @if (check(); as c) {
          <section [class]="'rounded-xl border p-4 ' + (c.risk === 'high' ? 'border-vermilion bg-vermilion/5' : c.risk === 'medium' ? 'border-marigold bg-marigold-light' : 'border-leaf bg-leaf-light')">
            <div class="mb-1 flex items-center gap-2"><svg [pcIcon]="Sparkles" class="h-4 w-4" /><p class="font-semibold">AI check</p><pc-pill [tone]="c.risk === 'high' ? 'red' : c.risk === 'medium' ? 'blue' : 'green'">{{ c.risk }} risk</pc-pill></div>
            @if (c.issues.length) {<ul class="list-disc pl-5">@for (i of c.issues; track i) {<li>{{ i }}</li>}</ul>} @else {<p>No problems found.</p>}
            @if (c.suggested_reason) {<button pcButton size="sm" variant="ghost" class="mt-2" (click)="reason.set(c.suggested_reason); rejecting.set(true)">Use as rejection reason</button>}
            <p class="mt-1 text-xs text-ink-faint">Suggestions only. You make the decision.</p>
          </section>
        }
        <div class="flex items-center gap-3"><pc-status-pill [status]="p.status" />@if (p.rejection_reason) {<span class="text-vermilion">{{ p.rejection_reason }}</span>}</div>
        <section class="rounded-xl bg-white p-5">
          <pc-admin-photo-editor [productId]="id()" [images]="p.images" (saved)="product.set($event); toast.show('Photos saved')" />
          <pc-admin-video-section [productId]="id()" [videos]="p.videos ?? []" (saved)="product.set($event); toast.show('Videos saved')" />
          <dl class="grid grid-cols-[150px_1fr] gap-y-1.5 text-[15px]">
            <dt class="text-ink-faint">Brand</dt><dd>{{ p.brand || "—" }}</dd>
            <dt class="text-ink-faint">HSN / GST</dt><dd>{{ p.hsn_code }} at {{ pct(p.gst_bps) }}</dd>
            <dt class="text-ink-faint">Country of origin</dt><dd>{{ p.country_of_origin }}</dd>
            <dt class="text-ink-faint">Return window</dt><dd>{{ p.return_window_days ? p.return_window_days + " days" : "Not returnable" }}</dd>
            <dt class="text-ink-faint">Highlights</dt><dd>{{ p.highlights.join("; ") || "—" }}</dd>
            <dt class="text-ink-faint">Description</dt><dd class="whitespace-pre-line">{{ p.description }}</dd>
            <dt class="text-ink-faint">Specifications</dt><dd>{{ specs() || "—" }}</dd>
          </dl>
        </section>
        <section class="rounded-xl bg-white p-5" aria-labelledby="pinfo-h">
          <h2 id="pinfo-h" class="mb-2 text-lg font-semibold">Product information</h2>
          @if ((p.missing_details?.length ?? 0) > 0) {
            <p class="mb-3 rounded-lg bg-marigold-light p-2 text-sm"><span class="font-semibold">Missing for this category:</span> {{ p.missing_details!.join(", ") }}</p>
          } @else if ((p.required_details?.length ?? 0) > 0) {
            <p class="mb-3 text-sm text-leaf">Everything this category requires is filled in.</p>
          }
          <dl class="grid grid-cols-[180px_1fr] gap-y-1.5 text-[15px]">
            @for (row of info(); track row[0]) {
              <div class="contents"><dt class="text-ink-faint">{{ row[0] }}</dt><dd class="whitespace-pre-line">{{ row[1] || "—" }}</dd></div>
            }
          </dl>
        </section>
        <pc-table [head]="['Version', 'SKU', 'MRP', 'Price', 'Discount', 'Stock', 'On sale']">
          @for (v of p.variants; track v.id) {
            <tr>
              <td class="px-4 py-2">{{ v.label || "Single version" }}</td>
              <td class="px-4 py-2 font-mono text-sm">{{ v.sku }}</td>
              <td class="px-4 py-2">{{ rupees(v.mrp_paise) }}</td>
              <td class="px-4 py-2">{{ rupees(v.price_paise) }}</td>
              <td [class]="v.discount_pct >= 70 ? 'px-4 py-2 font-semibold text-vermilion' : 'px-4 py-2'">{{ v.discount_pct }}%</td>
              <td class="px-4 py-2">{{ v.stock }}</td>
              <td class="px-4 py-2">{{ v.is_active ? "Yes" : "No" }}</td>
            </tr>
          }
        </pc-table>
        <pc-modal [open]="rejecting()" (close)="rejecting.set(false)" [title]="p.status === 'approved' ? 'Take down listing' : 'Reject listing'">
          <div class="mb-2 flex flex-wrap gap-1.5">
            @for (r of quickReasons; track r) {
              <button type="button" (click)="reason.set(r)" class="rounded-full bg-mist px-3 py-1 text-left text-sm hover:bg-peacock-light">{{ r }}</button>
            }
          </div>
          <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="The seller sees this message" aria-label="Reason"></textarea>
          <button pcButton class="mt-3" variant="buy" [disabled]="reason().trim().length < 5" [loading]="busy()" (click)="act('reject')">{{ p.status === "approved" ? "Take down" : "Reject" }}</button>
        </pc-modal>
      </div>
    }
  `,
})
export class AdminProductsIdPage {
  readonly id = input.required<string>();
  private readonly router = inject(Router);
  protected readonly toast = inject(Toast);
  protected readonly site = inject(SiteService);
  protected readonly Sparkles = Sparkles;
  protected readonly pct = pct;
  protected readonly rupees = rupees;
  protected readonly quickReasons = QUICK_REASONS;
  protected readonly product = signal<SellerProduct | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly rejecting = signal(false);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly check = signal<Check | null>(null);
  protected readonly checking = signal(false);
  protected readonly specs = computed(() => Object.entries(this.product()?.specs ?? {}).map(([k, v]) => `${k}: ${v}`).join("; "));
  protected readonly info = computed<[string, string | undefined][]>(() => {
    const p = this.product();
    if (!p) return [];
    const d = p.details;
    return [
      ["Generic name", d?.generic_name], ["Model number", d?.model_number],
      ["Net quantity", d?.net_unit ? `${p.variants.map((v) => v.net_qty ?? "?").join(" / ")} ${d.net_unit}` : ""],
      ["Manufacturer", d?.manufacturer], ["Packer", d?.packer], ["Importer", d?.importer],
      ["Consumer care", d?.customer_care], ["FSSAI licence", d?.fssai_license], ["Best before", d?.shelf_life],
      ["Warranty", d?.warranty], ["In the box", d?.in_the_box.join(", ")],
      ["Dimensions", d?.length_cm ? `${d.length_cm} × ${d.width_cm} × ${d.height_cm} cm` : ""],
      ["Ingredients", d?.ingredients], ["Directions", d?.directions], ["Safety", d?.safety_info], ["Legal disclaimer", d?.legal_disclaimer],
    ];
  });

  constructor() {
    effect(() => {
      const id = this.id();
      api<SellerProduct>(`/api/admin/products/${id}`).then((p) => this.product.set(p)).catch((e) => this.error.set(e.message));
    });
  }

  protected async runCheck(): Promise<void> {
    this.checking.set(true);
    this.error.set(null);
    try {
      this.check.set(await api<Check>(`/api/admin/products/${this.id()}/ai-check`, { method: "POST" }));
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "The AI check is not available");
    } finally {
      this.checking.set(false);
    }
  }

  protected subtitle(p: SellerProduct): string {
    return [p.seller ? `${p.seller.name} (${p.seller.status})` : "", p.category_name].filter(Boolean).join(", ");
  }

  protected readonly goLive = signal<string | null>(null);

  protected goLiveValue(): string {
    const typed = this.goLive();
    if (typed !== null) return typed;
    const v = this.product()?.publish_at;
    if (!v) return "";
    const d = new Date(v);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  protected readonly unitLimit = signal<string | null>(null);

  protected unitLimitValue(): string {
    return this.unitLimit() ?? String(this.product()?.details?.max_qty ?? 0);
  }

  protected async saveUnitLimit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.product.set(await api<SellerProduct>(`/api/admin/products/${this.id()}/unit-limit`, { method: "PUT", body: { max_qty: Number(this.unitLimitValue()) } }));
      this.unitLimit.set(null);
      this.toast.show("Limit saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Failed");
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveGoLive(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const v = this.goLiveValue();
      this.product.set(await api<SellerProduct>(`/api/admin/products/${this.id()}/publish-at`, { method: "PUT", body: { publish_at: v ? new Date(v).toISOString() : null } }));
      this.goLive.set(null);
      this.toast.show("Go-live time saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Failed");
    } finally {
      this.busy.set(false);
    }
  }

  protected async act(kind: "approve" | "reject"): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/products/${this.id()}/${kind}`, { method: "POST", body: kind === "reject" ? { reason: this.reason() } : undefined });
      this.toast.show(kind === "approve" ? "Listing approved" : "Listing rejected");
      void this.router.navigateByUrl("/admin/products");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Failed");
      this.busy.set(false);
    }
  }
}
