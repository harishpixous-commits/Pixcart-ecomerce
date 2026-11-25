/*
 * The media library (Admin → Storefront → Media library) and the image and video fields that pick from it.
 * Images take the product photo pipeline (checked, resized, saved as WebP, up to 5 MB); MP4 and WebM videos are
 * stored as uploaded, up to the video size limit in Admin → Product page. GET /api/admin/media returns each item's
 * kind ("image" or "video") and takes ?kind= to list only one of them.
 *
 * <pc-image-field> and <pc-video-field> show a live preview of the chosen file and open <pc-media-library>, a dialog
 * that can sit on top of another dialog (Escape and clicks outside close only the library). Port of
 * components/media-picker.tsx:
 *   <pc-media-grid [onPick] [refreshKey] accept="any|image|video" [selected] />
 *   <pc-media-library [open] (close) (pick) accept [selected] title />
 *   <pc-image-field label [value] (valueChange) aspect hint layout />   <pc-video-field ... [poster] />
 */

import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, booleanAttribute, computed, effect, inject, input, model, output, signal, untracked, viewChild,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { Check, Copy, Film, ImagePlus, Trash2, Upload, X } from "lucide-angular";
import { api, ApiError, quietly, uploadWithProgress } from "../../core/api";
import { SiteService } from "../../core/site";
import { isVideoUrl, MediaFill, reducedMotion } from "../../shared/chrome/media";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { Button, Toast } from "../../shared/ui/ui";

export type MediaKind = "image" | "video";
/** What a picker takes: images only, videos only, or either. */
export type MediaAccept = MediaKind | "any";
export type MediaItem = { id: string; url: string; label: string; at: string; kind?: MediaKind };

export const VIDEO_HINT = "Plays muted on a loop; the image is shown until it loads and for shoppers who turn off motion";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/webm"];
const IMAGE_MB = 5;
const MB = 1024 * 1024;
const FILTERS: [MediaAccept, string][] = [["any", "All"], ["image", "Images"], ["video", "Videos"]];

/** An item's kind (sent by the API; told apart by the file type in the address for older replies). */
export function mediaKind(m: { url: string; kind?: MediaKind }): MediaKind {
  return m.kind ?? (isVideoUrl(m.url) ? "video" : "image");
}

/** Uploads one image or video to the library and returns the new item. */
export function uploadMediaItem(file: File, label = "", onProgress: (fraction: number) => void = () => {}): Promise<MediaItem> {
  const query = label ? `?label=${encodeURIComponent(label.slice(0, 120))}` : "";
  return uploadWithProgress<MediaItem>(`/api/admin/media${query}`, file, onProgress);
}

/** Uploads one image or video to the library and returns its address. */
export async function uploadMedia(file: File, label = ""): Promise<string> {
  return (await uploadMediaItem(file, label)).url;
}

/** Why a file cannot be uploaded here, or null when it can (the server checks the content again). */
function fileProblem(f: File, accept: MediaAccept, videoMb: number): string | null {
  const video = VIDEO_TYPES.includes(f.type) || (!f.type && /\.(mp4|webm)$/i.test(f.name));
  const image = IMAGE_TYPES.includes(f.type) || (!f.type && /\.(jpe?g|png|webp)$/i.test(f.name));
  if (video && accept === "image") return `${f.name} is a video. Choose an image here.`;
  if (image && accept === "video") return `${f.name} is an image. Choose an MP4 or WebM video here.`;
  if (!video && !image) {
    const wanted = accept === "video" ? "an MP4 or WebM video" : accept === "image" ? "a JPG, PNG or WebP image" : "a JPG, PNG or WebP image, or an MP4 or WebM video";
    return `${f.name} cannot be used. Upload ${wanted}.`;
  }
  if (video && f.size > videoMb * MB) return `${f.name} is larger than ${videoMb} MB, the video limit.`;
  if (image && f.size > IMAGE_MB * MB) return `${f.name} is larger than ${IMAGE_MB} MB, the image limit.`;
  return null;
}

function uploadCopy(accept: MediaAccept, videoMb: number): { title: string; note: string; types: string } {
  const images = `JPG, PNG or WebP up to ${IMAGE_MB} MB`;
  const videos = `MP4 or WebM up to ${videoMb} MB`;
  if (accept === "image") return { title: "Upload images", note: `${images} each. Banners look best at 1600 × 600.`, types: IMAGE_TYPES.join(",") };
  if (accept === "video") return { title: "Upload videos", note: `${videos} each. Short, silent loops work best.`, types: VIDEO_TYPES.join(",") };
  return { title: "Upload images or videos", note: `Images: ${images}. Videos: ${videos}.`, types: [...IMAGE_TYPES, ...VIDEO_TYPES].join(",") };
}

const VIDEO_BADGE = `<span class="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-ink/75 px-2 py-0.5 text-[11px] font-semibold text-white"><svg [pcIcon]="Film" class="h-3 w-3" /> Video</span>`;

@Component({
  selector: "li[pcMediaTile]",
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class]": "cls()",
    "(mouseenter)": "preview(true)", "(mouseleave)": "preview(false)", "(focusin)": "preview(true)", "(focusout)": "preview(false)",
  },
  template: `
    <ng-template #thumb>
      @if (video()) {
        <video #v [src]="m().url + '#t=0.1'" muted loop playsinline preload="metadata" aria-hidden="true" class="h-full w-full object-cover"></video>
      } @else {
        <img [src]="m().url" alt="" loading="lazy" decoding="async" class="h-full w-full object-cover" />
      }
      @if (video()) {${VIDEO_BADGE}}
      @if (picked()) {
        <span class="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-peacock text-white shadow-card"><svg [pcIcon]="Check" class="h-4 w-4" /></span>
      }
    </ng-template>
    @if (pickable()) {
      <button type="button" (click)="pick.emit(m())" [attr.aria-label]="'Use ' + name() + (picked() ? ' (in use now)' : '')"
        class="group relative block aspect-[16/9] w-full overflow-hidden bg-mist">
        <ng-container [ngTemplateOutlet]="thumb" />
        <span class="pointer-events-none absolute inset-0 bg-ink/0 transition-colors group-hover:bg-ink/10"></span>
      </button>
    } @else {
      <div class="relative aspect-[16/9] w-full overflow-hidden bg-mist"><ng-container [ngTemplateOutlet]="thumb" /></div>
    }
    <div class="flex min-h-9 items-center gap-1 px-2 py-1 text-xs">
      <span class="min-w-0 flex-1 truncate text-ink-soft" [attr.title]="m().label">@if (picked()) {<b class="font-semibold text-peacock">In use · </b>}{{ name() }}</span>
      @if (!pickable()) {
        <button type="button" [attr.aria-label]="'Copy the link to ' + name()" class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-medium text-peacock hover:bg-peacock-light" (click)="copy()">
          <svg [pcIcon]="Copy" class="h-3.5 w-3.5" /> Copy link
        </button>
      }
    </div>
  `,
})
export class MediaTile {
  readonly m = input.required<MediaItem>();
  readonly picked = input(false);
  readonly pickable = input(false);
  readonly pick = output<MediaItem>();
  private readonly toast = inject(Toast);
  private readonly reduced = reducedMotion();
  private readonly v = viewChild<ElementRef<HTMLVideoElement>>("v");
  protected readonly Check = Check;
  protected readonly Copy = Copy;
  protected readonly Film = Film;
  protected readonly video = computed(() => mediaKind(this.m()) === "video");
  protected readonly name = computed(() => this.m().label || (this.video() ? "Video" : "Image"));
  protected readonly cls = computed(() => cx("overflow-hidden rounded-lg border bg-white transition-shadow", this.picked() ? "border-peacock ring-2 ring-peacock" : "border-line", this.pickable() && "hover:shadow-card"));

  // videos stay still on their first frame and play (muted) while pointed at or focused
  protected preview(on: boolean): void {
    const el = this.v()?.nativeElement;
    if (!el) return;
    if (on && !this.reduced()) {
      el.muted = true;
      el.play().catch(() => {});
    } else el.pause();
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.m().url);
    this.toast.show("Link copied");
  }
}

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4";

/**
 * The library: upload (button or drag and drop) and a grid of everything uploaded, newest first. With `pickable` it is
 * a picker (choosing an item emits pick; uploading a single file picks it at once); without, each item has a copy-link
 * button. `accept` limits what is listed and uploaded; "any" shows an All / Images / Videos filter.
 */
@Component({
  selector: "pc-media-grid",
  imports: [Icon, MediaTile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3" },
  template: `
    <label (dragover)="onDragOver($event)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)" [class]="dropCls()">
      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock"><svg [pcIcon]="Upload" class="h-5 w-5" /></span>
      <span class="flex min-w-0 flex-col">
        <span class="font-semibold text-peacock">{{ copyText().title }}<span class="hidden font-normal text-ink-soft sm:inline"> or drop them here</span></span>
        <span class="text-sm text-ink-soft">{{ copyText().note }}</span>
      </span>
      <input type="file" multiple [attr.accept]="copyText().types" class="sr-only" [disabled]="busy()" (change)="onFiles($event)" />
    </label>

    @if (progress(); as p) {
      <div role="status" class="rounded-lg bg-mist px-3 py-2 text-sm">
        <div class="mb-1.5 flex items-center justify-between gap-3">
          <span class="min-w-0 truncate">{{ p.done >= 1 ? "Saving" : "Uploading" }} {{ p.name }}{{ p.of > 1 ? " (" + p.at + " of " + p.of + ")" : "" }}</span>
          <span class="shrink-0 tabular-nums text-ink-soft">{{ round(p.done * 100) }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-line">
          <div class="h-full rounded-full bg-peacock transition-[width] duration-200" [style.width.%]="max(3, p.done * 100)"></div>
        </div>
      </div>
    }
    @if (problems().length > 0) {
      <ul role="alert" class="flex flex-col gap-0.5 rounded-lg bg-vermilion-light px-3 py-2 text-sm text-vermilion">
        @for (p of problems(); track $index) {<li>{{ p }}</li>}
      </ul>
    }

    <div class="flex min-h-10 flex-wrap items-center justify-between gap-2">
      @if (accept() === "any") {
        <div role="group" aria-label="Show" class="inline-flex rounded-lg bg-mist p-1">
          @for (f of filters; track f[0]) {
            <button type="button" [attr.aria-pressed]="filter() === f[0]" (click)="filter.set(f[0])"
              [class]="filter() === f[0] ? 'h-10 rounded-md px-3.5 text-sm font-medium transition-colors sm:h-8 bg-white text-peacock shadow-sm' : 'h-10 rounded-md px-3.5 text-sm font-medium transition-colors sm:h-8 text-ink-soft hover:text-ink'">{{ f[1] }}</button>
          }
        </div>
      } @else {
        <p class="text-sm font-semibold text-ink">{{ accept() === "video" ? "Your videos" : "Your images" }}</p>
      }
      @if (items() && items()!.length > 0) {
        <p class="text-sm text-ink-faint">{{ items()!.length === 1 ? "1 file" : items()!.length + " files" }}{{ pickable() ? " · choose one to use it" : "" }}</p>
      }
    </div>

    @if (!items()) {
      <ul class="${GRID}" aria-busy="true" aria-label="Loading the media library">
        @for (i of eight; track i) {
          <li class="overflow-hidden rounded-lg border border-line bg-white">
            <div class="skeleton aspect-[16/9]"></div>
            <div class="flex h-9 items-center px-2"><div class="skeleton h-3 w-2/3 rounded"></div></div>
          </li>
        }
      </ul>
    } @else if (items()!.length === 0) {
      <div class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-10 text-center text-ink-soft">
        <svg [pcIcon]="shown() === 'video' ? Film : ImagePlus" class="h-8 w-8 text-ink-faint" />
        <p>{{ shown() === "video" ? "No videos yet." : shown() === "image" ? "No images yet." : "Nothing uploaded yet." }} Upload one above.</p>
      </div>
    } @else {
      <ul class="${GRID} animate-fade-in">
        @for (m of items(); track m.id) {
          <li pcMediaTile [m]="m" [picked]="!!selected() && selected() === m.url" [pickable]="pickable()" (pick)="pick.emit($event)"></li>
        }
      </ul>
    }
  `,
})
export class MediaGrid {
  readonly pickable = input(false, { transform: booleanAttribute });
  readonly refreshKey = input(0);
  readonly accept = input<MediaAccept>("any");
  /** the address in use now, marked in the grid */
  readonly selected = input<string | undefined>(undefined);
  readonly pick = output<MediaItem>();
  private readonly toast = inject(Toast);
  private readonly site = inject(SiteService);
  protected readonly Upload = Upload;
  protected readonly Film = Film;
  protected readonly ImagePlus = ImagePlus;
  protected readonly filters = FILTERS;
  protected readonly eight = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly round = Math.round;
  protected readonly max = Math.max;
  /** The largest video the library takes: the product video limit from Admin → Product page. */
  private readonly videoMb = computed(() => this.site.site().gallery?.max_video_mb ?? 50);
  protected readonly filter = signal<MediaAccept>("any");
  protected readonly shown = computed<MediaAccept>(() => (this.accept() === "any" ? this.filter() : this.accept()));
  private readonly key = computed(() => `${this.shown()}|${this.refreshKey()}`);
  // the list remembers the filter it is for, so switching shows placeholders
  private readonly list = signal<{ key: string; items: MediaItem[] } | null>(null);
  protected readonly items = computed(() => {
    const l = this.list();
    return l?.key === this.key() ? l.items : null;
  });
  protected readonly progress = signal<{ name: string; at: number; of: number; done: number } | null>(null);
  protected readonly problems = signal<string[]>([]);
  protected readonly dragging = signal(false);
  protected readonly busy = computed(() => this.progress() !== null);
  protected readonly copyText = computed(() => uploadCopy(this.accept(), this.videoMb()));
  protected readonly dropCls = computed(() => cx("flex items-center gap-3 rounded-xl border-2 border-dashed p-4 transition-colors",
    this.busy() ? "cursor-wait border-line opacity-70" : "cursor-pointer",
    !this.busy() && (this.dragging() ? "border-peacock bg-peacock-light" : "border-peacock/40 hover:bg-peacock-light")));

  constructor() {
    effect((onCleanup) => {
      const key = this.key();
      const shown = this.shown();
      let live = true;
      api<MediaItem[]>("/api/admin/media", { query: shown === "any" ? undefined : { kind: shown } })
        .then((items) => { if (live) this.list.set({ key, items }); })
        .catch(quietly);
      onCleanup(() => (live = false));
    });
  }

  protected onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (!this.dragging()) this.dragging.set(true);
  }

  protected onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragging.set(false);
    void this.upload(Array.from(e.dataTransfer?.files ?? []));
  }

  protected onFiles(e: Event): void {
    const el = e.target as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = "";
    void this.upload(files);
  }

  private async upload(files: File[]): Promise<void> {
    if (!files.length || this.progress()) return;
    const accept = this.accept();
    const errors: string[] = [];
    const ready = files.slice(0, 10).filter((f) => {
      const problem = fileProblem(f, accept, this.videoMb());
      if (problem) errors.push(problem);
      return !problem;
    });
    if (files.length > 10) errors.push("Upload up to 10 files at a time.");
    this.problems.set([]);
    const added: MediaItem[] = [];
    for (let i = 0; i < ready.length; i++) {
      const f = ready[i];
      const step = { name: f.name, at: i + 1, of: ready.length };
      this.progress.set({ ...step, done: 0 });
      try {
        added.push(await uploadMediaItem(f, f.name, (done) => this.progress.set({ ...step, done })));
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof ApiError ? e.message : "the upload failed. Try again."}`);
      }
    }
    this.progress.set(null);
    this.problems.set(errors);
    if (!added.length) return;
    const shown = this.shown();
    const key = this.key();
    const fits = added.filter((m) => shown === "any" || mediaKind(m) === shown).reverse();
    this.list.update((l) => (l && l.key === key ? { ...l, items: [...fits, ...l.items] } : l));
    if (this.pickable() && files.length === 1 && (accept === "any" || mediaKind(added[0]) === accept)) this.pick.emit(added[0]);
    else this.toast.show(added.length === 1 ? "Uploaded to the media library" : `${added.length} files uploaded to the media library`);
  }
}

/** The library as a dialog for picking one file. It can open on top of another dialog (a fixed layer on <body>). */
@Component({
  selector: "pc-media-library",
  imports: [Icon, MediaGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (open()) {
      <div #layer class="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 animate-fade-in sm:items-center sm:p-4" (mousedown)="close.emit()">
        <div #panel tabindex="-1" role="dialog" aria-modal="true" [attr.aria-label]="title()"
          class="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-panel outline-none animate-rise-in sm:max-w-3xl sm:rounded-2xl"
          (mousedown)="$event.stopPropagation()">
          <div class="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
            <h2 class="font-display text-lg font-semibold text-ink">{{ title() }}</h2>
            <button type="button" (click)="close.emit()" class="-mr-1.5 flex h-10 w-10 items-center justify-center rounded-full text-ink-soft hover:bg-mist" aria-label="Close">
              <svg [pcIcon]="X" class="h-5 w-5" />
            </button>
          </div>
          <div class="overflow-y-auto overscroll-contain p-4 sm:p-5">
            <pc-media-grid [accept]="accept()" [selected]="selected()" [pickable]="pickable()" (pick)="pick.emit($event)" />
          </div>
        </div>
      </div>
    }
  `,
})
export class MediaLibrary {
  readonly open = input(false, { transform: booleanAttribute });
  readonly accept = input<MediaAccept>("any");
  readonly selected = input<string | undefined>(undefined);
  readonly title = input("Media library");
  readonly pickable = input(true, { transform: booleanAttribute });
  readonly close = output<void>();
  readonly pick = output<MediaItem>();
  protected readonly X = X;
  private readonly layer = viewChild<ElementRef<HTMLElement>>("layer");
  private readonly panel = viewChild<ElementRef<HTMLElement>>("panel");

  constructor() {
    // listening on window in the capture phase runs before a dialog underneath, so Escape closes only this one
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !this.open()) return;
      e.stopPropagation();
      this.close.emit();
    };
    window.addEventListener("keydown", onKey, true);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("keydown", onKey, true));

    // a layer on <body> keeps the dialog fixed to the screen even inside another dialog
    effect((onCleanup) => {
      const layer = this.layer()?.nativeElement;
      if (!layer) return;
      document.body.appendChild(layer);
      const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      untracked(() => this.panel()?.nativeElement.focus());
      onCleanup(() => {
        document.body.style.overflow = overflow;
        back?.focus();
      });
    });
  }
}

/** An image or video field: a live preview of the chosen file and buttons to choose another (from the library) or remove it. */
@Component({
  selector: "pc-media-field",
  imports: [Icon, Button, MediaFill, MediaLibrary, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-w-0" },
  template: `
    <ng-template #preview>
      <button type="button" tabindex="-1" (click)="isOpen.set(true)" [attr.aria-label]="(value() ? 'Change ' : 'Choose ') + lower()" [class]="previewCls()">
        @if (value()) {
          @if (video()) {<pc-media-fill [image]="poster() || undefined" [video]="value()" />} @else {<img [src]="value()" alt="" class="h-full w-full object-cover" />}
        } @else {
          <span class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-faint transition-colors group-hover:text-peacock">
            <svg [pcIcon]="video() ? Film : ImagePlus" class="h-5 w-5" />
            <span class="text-[11px] font-medium">{{ video() ? "No video" : "No image" }}</span>
          </span>
        }
        @if (value() && video()) {${VIDEO_BADGE}}
      </button>
    </ng-template>
    <ng-template #actions>
      <div class="flex flex-wrap items-center gap-1">
        <button pcButton type="button" size="sm" variant="secondary" (click)="isOpen.set(true)">{{ value() ? "Change" : video() ? "Choose video" : "Choose image" }}</button>
        @if (value()) {
          <button pcButton type="button" size="sm" variant="ghost" (click)="value.set('')" [attr.aria-label]="'Remove ' + lower()" title="Remove">
            <svg [pcIcon]="Trash2" class="h-4 w-4" />@if (!compact()) {Remove}
          </button>
        }
      </div>
    </ng-template>
    @if (compact()) {
      <div class="flex items-start gap-3">
        <ng-container [ngTemplateOutlet]="preview" />
        <div class="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <p class="text-sm font-medium text-ink">{{ label() }}</p>
          <ng-container [ngTemplateOutlet]="actions" />
          @if (hint()) {<p class="text-xs text-ink-faint">{{ hint() }}</p>}
        </div>
      </div>
    } @else {
      <p class="mb-1 text-sm font-medium text-ink">{{ label() }}</p>
      <div class="flex items-start gap-3">
        <ng-container [ngTemplateOutlet]="preview" />
        <div class="flex min-w-0 flex-col items-start gap-1.5">
          <ng-container [ngTemplateOutlet]="actions" />
          @if (hint()) {<p class="text-xs text-ink-faint">{{ hint() }}</p>}
        </div>
      </div>
    }
    <pc-media-library [open]="isOpen()" (close)="isOpen.set(false)" [accept]="accept()" [selected]="value()" [title]="video() ? 'Choose a video' : 'Choose an image'"
      (pick)="value.set($event.url); isOpen.set(false)" />
  `,
})
export class MediaField {
  readonly label = input.required<string>();
  readonly value = model<string>("");
  readonly accept = input<MediaKind>("image");
  /** the preview's shape, a Tailwind aspect class */
  readonly aspect = input("aspect-[16/9]");
  readonly hint = input<string | undefined>(undefined);
  /** a video's cover picture (usually the block's image), shown until the video plays */
  readonly poster = input<string | undefined>(undefined);
  /** row: label on top, preview beside the buttons; compact: a smaller preview with the label beside it */
  readonly layout = input<"row" | "compact">("row");
  protected readonly Film = Film;
  protected readonly ImagePlus = ImagePlus;
  protected readonly Trash2 = Trash2;
  protected readonly isOpen = signal(false);
  protected readonly video = computed(() => this.accept() === "video");
  protected readonly lower = computed(() => this.label().toLowerCase());
  protected readonly compact = computed(() => this.layout() === "compact");
  protected readonly previewCls = computed(() => cx("group relative shrink-0 overflow-hidden rounded-lg border border-line bg-mist", this.compact() ? "w-28 sm:w-32" : "w-40", this.aspect()));
}

/** An image field: shows the current image, opens the library to choose or upload another. */
@Component({
  selector: "pc-image-field",
  imports: [MediaField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-media-field [label]="label()" [(value)]="value" accept="image" [aspect]="aspect()" [hint]="hint()" [layout]="layout()" />`,
})
export class ImageField {
  readonly label = input.required<string>();
  readonly value = model<string>("");
  readonly aspect = input("aspect-[16/9]");
  readonly hint = input<string | undefined>(undefined);
  readonly layout = input<"row" | "compact">("row");
}

/** An optional video field; pass the block's image as `poster` so the preview shows what shoppers see first. */
@Component({
  selector: "pc-video-field",
  imports: [MediaField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-media-field [label]="label()" [(value)]="value" accept="video" [aspect]="aspect()" [hint]="hint()" [layout]="layout()" [poster]="poster()" />`,
})
export class VideoField {
  readonly label = input("Video (optional)");
  readonly value = model<string>("");
  readonly aspect = input("aspect-[16/9]");
  readonly hint = input<string | undefined>(VIDEO_HINT);
  readonly layout = input<"row" | "compact">("row");
  readonly poster = input<string | undefined>(undefined);
}
