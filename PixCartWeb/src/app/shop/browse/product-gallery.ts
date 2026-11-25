/*
 * Product photos and videos, the way shoppers know it from big marketplaces:
 * - Desktop: hover a thumbnail to show it; hover the photo to magnify it in a panel beside it (lens + zoom view);
 *   click the photo for the full-screen viewer.
 * - Phone: swipe between photos; tap for the full-screen viewer.
 * - Full-screen viewer: VIDEOS and IMAGES tabs, large photo (click to zoom, arrows/keys to move), video player.
 * Zoom on/off and strength come from Admin → Marketplace settings → Product page.
 * Port of components/product-gallery.tsx: <pc-product-gallery [images] [videos] [title] [zoom] [zoomLevel] />.
 */

import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild,
} from "@angular/core";
import { ChevronLeft, ChevronRight, Expand, Play, X, ZoomIn } from "lucide-angular";
import type { ProductVideo } from "../../core/types";
import { Icon } from "../../shared/ui/icon";

const dur = (s: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";
/** A mouse or trackpad (not touch): only then does hover-to-zoom make sense. */
export function canHoverSignal() {
  const mq = window.matchMedia(HOVER_QUERY);
  const s = signal(mq.matches);
  const cb = () => s.set(mq.matches);
  mq.addEventListener("change", cb);
  inject(DestroyRef).onDestroy(() => mq.removeEventListener("change", cb));
  return s.asReadonly();
}

/** Renders the host on <body> while it lives (React's createPortal(..., document.body)). */
export function portalToBody() {
  const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  afterNextRender(() => document.body.appendChild(el));
  inject(DestroyRef).onDestroy(() => el.remove());
}

@Component({
  selector: "pc-video-thumb",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="pick.emit()" [attr.aria-label]="'Play video' + (v().title ? ': ' + v().title : '')"
      [class]="active() ? 'relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-ink border-peacock' : 'relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-ink border-line'">
      @if (v().poster_url) {
        <img [src]="v().poster_url" alt="" class="h-full w-full object-cover opacity-90" />
      } @else {
        <video [src]="v().url + '#t=0.5'" preload="metadata" [muted]="true" class="h-full w-full object-cover"></video>
      }
      <span class="absolute inset-0 flex items-center justify-center"><span class="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow"><svg [pcIcon]="Play" class="ml-0.5 h-3.5 w-3.5 fill-ink text-ink" /></span></span>
    </button>
  `,
})
export class VideoThumb {
  readonly v = input.required<ProductVideo>();
  readonly active = input(false);
  readonly pick = output<void>();
  protected readonly Play = Play;
}

/* ---------------------------------------------------------------- hover zoom */

type Lens = { x: number; y: number; w: number; h: number; iw: number; ih: number; ix: number; iy: number };

@Component({
  selector: "pc-zoom-image",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative block" },
  template: `
    <button #box type="button" (click)="open.emit()" (mousemove)="move($event)" (mouseleave)="lens.set(null)"
      [class]="enabled() ? 'relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-white cursor-crosshair' : 'relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-white cursor-zoom-in'"
      aria-label="Open the full-size photo">
      <img #img [src]="src()" [alt]="alt()" class="h-full w-full object-contain" draggable="false" />
      @if (lens(); as l) {
        <span aria-hidden="true" class="pointer-events-none absolute border border-peacock/60 bg-white/30"
          [style.left.px]="l.x" [style.top.px]="l.y" [style.width.px]="l.w" [style.height.px]="l.h"
          style="background-image: radial-gradient(rgba(11,85,99,.25) 1px, transparent 1px); background-size: 4px 4px"></span>
      }
    </button>
    @if (lens(); as l) {
      <!-- The magnified view sits beside the photo, over the product details (as on large marketplaces). -->
      <div aria-hidden="true" class="pointer-events-none absolute left-[calc(100%+16px)] top-0 z-30 hidden overflow-hidden rounded-xl border border-line bg-white shadow-2xl lg:block"
        [style.width.px]="l.w * level()" [style.height.px]="l.h * level()" [style.background-image]="bg()" style="background-repeat: no-repeat"
        [style.background-size]="l.iw * level() + 'px ' + l.ih * level() + 'px'"
        [style.background-position]="-(l.x - l.ix) * level() + 'px ' + -(l.y - l.iy) * level() + 'px'"></div>
    }
  `,
})
export class ZoomImage {
  readonly src = input.required<string>();
  readonly alt = input("");
  readonly level = input(2.5);
  readonly enabled = input(true);
  readonly open = output<void>();
  private readonly box = viewChild.required<ElementRef<HTMLButtonElement>>("box");
  private readonly img = viewChild.required<ElementRef<HTMLImageElement>>("img");
  protected readonly lens = signal<Lens | null>(null);
  protected readonly bg = computed(() => `url("${this.src()}")`);

  protected move(e: MouseEvent): void {
    const box = this.box().nativeElement, img = this.img().nativeElement;
    const level = this.level();
    if (!this.enabled() || !img.naturalWidth) return;
    const b = box.getBoundingClientRect();
    // Where the photo actually sits inside the square box (object-contain leaves margins).
    const scale = Math.min(b.width / img.naturalWidth, b.height / img.naturalHeight);
    const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
    const ix = (b.width - iw) / 2, iy = (b.height - ih) / 2;
    const w = Math.min(iw, b.width / level), h = Math.min(ih, b.height / level);
    const mx = e.clientX - b.left, my = e.clientY - b.top;
    if (mx < ix || mx > ix + iw || my < iy || my > iy + ih) {
      this.lens.set(null);
      return;
    }
    const x = Math.min(Math.max(mx - w / 2, ix), ix + iw - w);
    const y = Math.min(Math.max(my - h / 2, iy), iy + ih - h);
    this.lens.set({ x, y, w, h, iw, ih, ix, iy });
  }
}

/* ---------------------------------------------------------------- full-screen viewer */

export type ViewerStart = { tab: "images" | "videos"; index: number };

@Component({
  selector: "pc-gallery-viewer",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="fixed inset-0 z-[70] flex items-stretch justify-center bg-ink/60 p-0 sm:p-6" (mousedown)="close.emit()" role="dialog" aria-modal="true" [attr.aria-label]="title() + ': photos and videos'">
      <div class="flex w-full max-w-[1400px] flex-col overflow-hidden bg-white sm:rounded-2xl" (mousedown)="$event.stopPropagation()">
        <div class="flex items-center gap-6 border-b border-line px-4 sm:px-8">
          @if (videos().length > 0) {
            <button type="button" (click)="tab.set('videos')" [class]="tab() === 'videos' ? TAB + ' border-peacock text-peacock' : TAB + ' border-transparent text-ink-soft hover:text-ink'">Videos</button>
          }
          @if (images().length > 0) {
            <button type="button" (click)="tab.set('images')" [class]="tab() === 'images' ? TAB + ' border-peacock text-peacock' : TAB + ' border-transparent text-ink-soft hover:text-ink'">Images</button>
          }
          <button #closeBtn type="button" (click)="close.emit()" aria-label="Close" class="ml-auto rounded-full p-2 hover:bg-mist"><svg [pcIcon]="X" class="h-6 w-6" /></button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div class="relative flex min-h-0 flex-1 items-center justify-center bg-white p-2 sm:p-6">
            @if (tab() === "images") {
              <div class="flex h-full w-full items-center justify-center overflow-hidden" (touchstart)="touchStart($event)" (touchend)="touchEnd($event)">
                <img [src]="images()[img()]" [alt]="title() + ', photo ' + (img() + 1) + ' of ' + images().length" draggable="false"
                  (click)="zoomClick($event)" (mousemove)="zoomMove($event)"
                  [class]="zoomed() ? 'max-h-[72vh] max-w-full select-none object-contain transition-transform duration-200 scale-[2.2] cursor-zoom-out' : 'max-h-[72vh] max-w-full select-none object-contain transition-transform duration-200 cursor-zoom-in'"
                  [style.transform-origin]="origin()" />
              </div>
              @if (images().length > 1) {
                <button type="button" (click)="go(-1)" aria-label="Previous photo" class="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow ring-1 ring-line hover:bg-mist"><svg [pcIcon]="ChevronLeft" class="h-6 w-6" /></button>
                <button type="button" (click)="go(1)" aria-label="Next photo" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow ring-1 ring-line hover:bg-mist"><svg [pcIcon]="ChevronRight" class="h-6 w-6" /></button>
              }
              <p class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/70 px-3 py-0.5 text-xs text-white">{{ img() + 1 }} / {{ images().length }}{{ !zoomed() ? " · click to zoom" : "" }}</p>
            } @else {
              <div class="flex w-full max-w-4xl flex-col gap-2">
                @for (v of [videos()[vid()]]; track v.url) {
                  <video [src]="v.url" [attr.poster]="v.poster_url || null" controls autoplay playsinline class="max-h-[70vh] w-full rounded-xl bg-black" [attr.aria-label]="v.title || title()"></video>
                  <p class="text-lg font-semibold">{{ v.title || title() }}</p>
                }
              </div>
            }
          </div>
          <aside class="flex max-h-[30vh] shrink-0 flex-col gap-3 overflow-y-auto border-t border-line p-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
            <p class="hidden text-lg leading-snug lg:block">{{ title() }}</p>
            @if (tab() === "images") {
              <div class="grid grid-cols-5 gap-2 lg:grid-cols-4">
                @for (src of images(); track src + $index; let i = $index) {
                  <button type="button" (click)="img.set(i); zoomed.set(false)" [attr.aria-label]="'Photo ' + (i + 1)"
                    [class]="i === img() ? 'aspect-square overflow-hidden rounded-lg border-2 bg-white border-peacock' : 'aspect-square overflow-hidden rounded-lg border-2 bg-white border-line hover:border-peacock/50'">
                    <img [src]="src" alt="" class="h-full w-full object-contain" />
                  </button>
                }
              </div>
            } @else {
              <p class="rounded-lg bg-mist px-3 py-2 font-semibold">Videos for this product</p>
              @for (v of videos(); track v.url; let i = $index) {
                <button type="button" (click)="vid.set(i)" [class]="i === vid() ? 'flex items-start gap-3 rounded-lg p-1 text-left ring-2 ring-marigold' : 'flex items-start gap-3 rounded-lg p-1 text-left hover:bg-mist'">
                  <span class="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-ink">
                    @if (v.poster_url) {
                      <img [src]="v.poster_url" alt="" class="h-full w-full object-cover" />
                    } @else {
                      <video [src]="v.url + '#t=0.5'" preload="metadata" [muted]="true" class="h-full w-full object-cover"></video>
                    }
                    <svg [pcIcon]="Play" class="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
                    @if (v.duration_s > 0) {<span class="absolute bottom-0.5 right-0.5 rounded bg-ink/80 px-1 text-[11px] text-white">{{ dur(v.duration_s) }}</span>}
                  </span>
                  <span class="text-sm">{{ v.title || title() }}</span>
                </button>
              }
            }
          </aside>
        </div>
      </div>
    </div>
  `,
})
export class GalleryViewer {
  readonly images = input.required<string[]>();
  readonly videos = input.required<ProductVideo[]>();
  readonly title = input.required<string>();
  readonly start = input.required<ViewerStart>();
  readonly close = output<void>();
  protected readonly TAB = "-mb-px border-b-2 py-3 text-sm font-semibold uppercase tracking-wide";
  protected readonly X = X;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Play = Play;
  protected readonly dur = dur;
  protected readonly tab = signal<"images" | "videos">("images");
  protected readonly img = signal(0);
  protected readonly vid = signal(0);
  protected readonly zoomed = signal(false);
  protected readonly origin = signal("50% 50%");
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>("closeBtn");
  private touch: number | null = null;

  constructor() {
    portalToBody();
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.close.emit();
      else if (this.tab() === "images" && e.key === "ArrowRight") this.go(1);
      else if (this.tab() === "images" && e.key === "ArrowLeft") this.go(-1);
    };
    window.addEventListener("keydown", key);
    afterNextRender(() => this.closeBtn()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      prev?.focus();
    });
  }

  ngOnInit(): void {
    const s = this.start();
    this.tab.set(this.images().length ? s.tab : "videos");
    this.img.set(s.tab === "images" ? s.index : 0);
    this.vid.set(s.tab === "videos" ? s.index : 0);
  }

  protected go(d: number): void {
    this.zoomed.set(false);
    const n = this.images().length;
    this.img.update((i) => (i + d + n) % n);
  }

  private originAt(e: MouseEvent): string {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  }
  protected zoomClick(e: MouseEvent): void {
    this.origin.set(this.originAt(e));
    this.zoomed.update((z) => !z);
  }
  protected zoomMove(e: MouseEvent): void {
    if (this.zoomed()) this.origin.set(this.originAt(e));
  }
  protected touchStart(e: TouchEvent): void {
    this.touch = e.touches[0].clientX;
  }
  protected touchEnd(e: TouchEvent): void {
    if (this.touch !== null) {
      const dx = e.changedTouches[0].clientX - this.touch;
      if (Math.abs(dx) > 40) this.go(dx < 0 ? 1 : -1);
      this.touch = null;
    }
  }
}

/* ---------------------------------------------------------------- gallery */

@Component({
  selector: "pc-product-gallery",
  imports: [Icon, VideoThumb, ZoomImage, GalleryViewer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!images().length && !videos().length) {
      <div class="flex aspect-square items-center justify-center rounded-xl bg-mist text-ink-faint">No image</div>
    } @else {
      <!-- desktop and tablet -->
      <div class="hidden gap-3 sm:flex">
        <div class="flex max-h-[560px] flex-col gap-2 overflow-y-auto pr-1">
          @for (src of images(); track src + $index; let i = $index) {
            <button type="button" (mouseenter)="active.set(i)" (focus)="active.set(i)" (click)="viewer.set({ tab: 'images', index: i })"
              [class]="i === active() ? 'h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-white border-peacock' : 'h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 bg-white border-line hover:border-peacock/50'"
              [attr.aria-label]="'Photo ' + (i + 1)">
              <img [src]="src" alt="" class="h-full w-full object-contain" />
            </button>
          }
          @for (v of videos(); track v.url; let i = $index) {
            <div class="flex flex-col items-center">
              <pc-video-thumb [v]="v" (pick)="viewer.set({ tab: 'videos', index: i })" />
              <span class="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Video</span>
            </div>
          }
        </div>
        <div class="min-w-0 flex-1">
          @if (images().length) {
            <pc-zoom-image [src]="images()[shownIndex()]" [alt]="title()" [level]="level()" [enabled]="zoom() && canHover()" (open)="viewer.set({ tab: 'images', index: active() })" />
          } @else {
            <button type="button" (click)="viewer.set({ tab: 'videos', index: 0 })" class="flex aspect-square w-full items-center justify-center rounded-xl bg-ink text-white"><svg [pcIcon]="Play" class="h-12 w-12" /></button>
          }
          <p class="mt-2 flex items-center justify-center gap-1.5 text-sm text-ink-faint">
            @if (zoom() && canHover()) {<svg [pcIcon]="ZoomIn" class="h-4 w-4" />Roll over the photo to zoom in · click for full view} @else {<svg [pcIcon]="Expand" class="h-4 w-4" />Click the photo for full view}
          </p>
        </div>
      </div>

      <!-- phone -->
      <div class="sm:hidden">
        <div #swipe (scroll)="onSwipe()" class="flex snap-x snap-mandatory overflow-x-auto rounded-xl bg-white [scrollbar-width:none]">
          @for (src of images(); track src + $index; let i = $index) {
            <button type="button" (click)="viewer.set({ tab: 'images', index: i })" class="aspect-square w-full shrink-0 snap-center" [attr.aria-label]="'Open photo ' + (i + 1)">
              <img [src]="src" [alt]="i === 0 ? title() : ''" class="h-full w-full object-contain" [attr.loading]="i === 0 ? 'eager' : 'lazy'" />
            </button>
          }
        </div>
        <div class="mt-2 flex items-center justify-center gap-1.5">
          @if (images().length > 1) {
            @for (src of images(); track $index; let i = $index) {<span [class]="i === active() ? 'h-1.5 rounded-full transition-all w-4 bg-peacock' : 'h-1.5 rounded-full transition-all w-1.5 bg-line'"></span>}
          }
          @if (videos().length > 0) {
            <button type="button" (click)="viewer.set({ tab: 'videos', index: 0 })" class="ml-2 inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-white">
              <svg [pcIcon]="Play" class="h-3 w-3 fill-white" />{{ videos().length === 1 ? "Video" : videos().length + " videos" }}
            </button>
          }
        </div>
      </div>

      <!-- Rendered on <body>: the gallery sits in a sticky column, which would otherwise keep the viewer under the site header. -->
      @if (viewer(); as v) {
        <pc-gallery-viewer [images]="images()" [videos]="videos()" [title]="title()" [start]="v" (close)="viewer.set(null)" />
      }
    }
  `,
})
export class ProductGallery {
  readonly images = input.required<string[]>();
  readonly videos = input<ProductVideo[]>([]);
  readonly title = input.required<string>();
  readonly zoom = input(true);
  readonly zoomLevel = input(2.5);
  protected readonly Play = Play;
  protected readonly ZoomIn = ZoomIn;
  protected readonly Expand = Expand;
  protected readonly active = signal(0);
  protected readonly viewer = signal<ViewerStart | null>(null);
  protected readonly canHover = canHoverSignal();
  private readonly swipe = viewChild<ElementRef<HTMLDivElement>>("swipe");
  protected readonly level = computed(() => Math.min(Math.max(this.zoomLevel(), 1.5), 4));
  protected readonly shownIndex = computed(() => Math.min(this.active(), this.images().length - 1));

  constructor() {
    // a new product (same page component): start from its first photo
    effect(() => {
      this.images();
      this.active.set(0);
    });
  }

  /** Phone: keep the dots in step with swiping. */
  protected onSwipe(): void {
    const el = this.swipe()?.nativeElement;
    if (el) this.active.set(Math.round(el.scrollLeft / el.clientWidth));
  }
}
