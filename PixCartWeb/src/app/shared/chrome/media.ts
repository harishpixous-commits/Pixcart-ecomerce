/*
 * Images and videos in storefront blocks (hero slides, banners, card tiles, the media block). A video plays muted and
 * looped, starts only while it is on screen, shows its image as the poster, and does not play by itself for shoppers who
 * ask for reduced motion. Port of components/media.tsx: <pc-media-fill [image] [video] [alt] mediaClass [playing] [eager]>,
 * <pc-video-toggle [playing] (toggle) toggleClass tone>, reducedMotion() (a signal), isVideoUrl().
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, viewChild } from "@angular/core";
import { Pause, Play } from "lucide-angular";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";

/** True for a video file from the media library (mp4 or webm). */
export function isVideoUrl(url: string | undefined | null): boolean {
  return Boolean(url && /\.(mp4|webm)(?:[?#].*)?$/i.test(url));
}

const motionQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const reduced = signal(motionQuery?.matches ?? false);
motionQuery?.addEventListener("change", () => reduced.set(motionQuery.matches));

/** The shopper asked their device for less motion (useReducedMotion). */
export function reducedMotion() {
  return reduced.asReadonly();
}

@Component({
  selector: "pc-media-fill",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (video()) {
      <video #v [src]="video()" [attr.poster]="image() || null" muted loop playsinline [attr.preload]="eager() ? 'auto' : 'metadata'"
        [attr.aria-label]="alt() || null" [attr.aria-hidden]="alt() ? null : true" [class]="cls()"></video>
    } @else if (image()) {
      <img [src]="image()" [alt]="alt()" [attr.loading]="eager() ? 'eager' : 'lazy'" decoding="async" [class]="cls()" />
    } @else {
      <div [class]="'h-full w-full bg-mist ' + extra()" aria-hidden="true"></div>
    }
  `,
})
export class MediaFill {
  readonly image = input<string | undefined>(undefined);
  readonly video = input<string | undefined>(undefined);
  readonly alt = input("");
  /** the reference's className */
  readonly extra = input<string>("", { alias: "mediaClass" });
  readonly fit = input<"cover" | "contain">("cover");
  readonly eager = input(false);
  readonly playing = input(true);
  private readonly v = viewChild<ElementRef<HTMLVideoElement>>("v");
  private readonly visible = signal(false);
  private readonly reduced = reducedMotion();
  protected readonly cls = computed(() => cx("h-full w-full", this.fit() === "contain" ? "object-contain" : "object-cover", this.extra()));

  constructor() {
    let io: IntersectionObserver | null = null;
    effect(() => {
      const el = this.v()?.nativeElement;
      io?.disconnect();
      if (!el) return;
      io = new IntersectionObserver(([e]) => this.visible.set(e.isIntersecting && e.intersectionRatio > 0.2), { threshold: [0, 0.2, 0.6] });
      io.observe(el);
    });
    effect(() => {
      const el = this.v()?.nativeElement;
      if (!el) return;
      el.muted = true; // autoplay needs muted set on the element
      if (this.visible() && this.playing() && !this.reduced()) el.play().catch(() => {});
      else el.pause();
    });
    inject(DestroyRef).onDestroy(() => io?.disconnect());
  }
}

/** A small round play/pause button for a block with a video (place it outside the block's link). */
@Component({
  selector: "pc-video-toggle",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="toggle.emit()" [attr.aria-label]="playing() ? 'Pause video' : 'Play video'" [attr.aria-pressed]="!playing()" [class]="cls()">
      <svg [pcIcon]="playing() ? Pause : Play" class="h-3.5 w-3.5 fill-current" />
    </button>
  `,
})
export class VideoToggle {
  readonly playing = input.required<boolean>();
  readonly tone = input<"dark" | "light">("dark");
  readonly extra = input<string>("", { alias: "toggleClass" });
  readonly toggle = output<void>();
  protected readonly Pause = Pause;
  protected readonly Play = Play;
  protected readonly cls = computed(() => cx("pc-press flex h-8 w-8 items-center justify-center rounded-full shadow-sm backdrop-blur",
    this.tone() === "dark" ? "bg-ink/60 text-white hover:bg-ink/80" : "bg-white/85 text-ink hover:bg-white", this.extra()));
}
