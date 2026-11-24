/*
 * Pictures and videos on the home page: banners (single and in a banner grid) and the "Image or video block" (the
 * `media` section). Port of components/home-media.tsx: <pc-media-banner [cfg] [compact]>, <pc-media-block [cfg] [title]>.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import { MediaFill, VideoToggle, reducedMotion } from "../../shared/chrome/media";
import { cx } from "../../shared/ui/cx";
import { PcLink } from "../../shared/ui/link";

export type BannerCfg = { image: string; video?: string; link: string; heading?: string; text?: string; cta?: string };

export type MediaCfg = {
  image?: string; video?: string; link?: string; heading?: string; text?: string; cta?: string;
  align?: "left" | "center"; tone?: "light" | "dark"; aspect?: string; width?: "contained" | "full"; controls?: boolean;
};

/** A single banner, or one banner of a banner grid (`compact`). The image sets its height; a video plays over it. */
@Component({
  selector: "pc-media-banner",
  imports: [PcLink, MediaFill, VideoToggle, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #body>
      <div class="relative h-full w-full">
        @if (cfg().image) {<img [src]="cfg().image" [alt]="cfg().heading ? '' : 'Banner'" class="h-full w-full rounded-xl object-cover" />}
        @if (cfg().video) {
          <pc-media-fill [image]="cfg().image" [video]="cfg().video" [alt]="cfg().heading || cfg().image ? '' : 'Banner'" [playing]="playing()"
            [mediaClass]="cfg().image ? 'rounded-xl absolute inset-0' : 'rounded-xl block aspect-video'" />
        }
        @if (cfg().heading || cfg().text || cfg().cta) {
          <div [class]="compact() ? 'absolute inset-0 flex flex-col justify-center gap-1 rounded-xl bg-gradient-to-r from-ink/60 to-transparent text-white p-4' : 'absolute inset-0 flex flex-col justify-center gap-1 rounded-xl bg-gradient-to-r from-ink/60 to-transparent text-white p-6 sm:p-10'">
            @if (cfg().heading) {<p [class]="compact() ? 'max-w-md font-display font-bold text-xl' : 'max-w-md font-display font-bold text-2xl sm:text-4xl'">{{ t(cfg().heading) }}</p>}
            @if (cfg().text) {<p [class]="compact() ? 'max-w-md text-white/90 text-sm' : 'max-w-md text-white/90 sm:text-lg'">{{ t(cfg().text) }}</p>}
            @if (cfg().cta) {<span class="mt-1 self-start rounded-lg bg-marigold px-3 py-1.5 text-sm font-semibold text-ink">{{ t(cfg().cta) }}</span>}
          </div>
        }
      </div>
    </ng-template>
    <ng-template #node>
      @if (!cfg().link) {
        <div [class]="cx('overflow-hidden rounded-xl', fill())"><ng-container *ngTemplateOutlet="body" /></div>
      } @else if (cfg().link.startsWith("https://")) {
        <a [href]="cfg().link" target="_blank" rel="noopener noreferrer" [class]="cx('block overflow-hidden rounded-xl', fill())"><ng-container *ngTemplateOutlet="body" /></a>
      } @else {
        <a [pcLink]="cfg().link" [class]="cx('block overflow-hidden rounded-xl', fill())"><ng-container *ngTemplateOutlet="body" /></a>
      }
    </ng-template>
    @if (cfg().image || cfg().video) {
      @if (!cfg().video) {
        <ng-container *ngTemplateOutlet="node" />
      } @else {
        <div class="relative h-full">
          <ng-container *ngTemplateOutlet="node" />
          @if (!reduced()) {<pc-video-toggle [playing]="playing()" (toggle)="playing.set(!playing())" [toggleClass]="compact() ? 'absolute z-10 right-2 top-2' : 'absolute z-10 right-3 top-3'" />}
        </div>
      }
    }
  `,
})
export class MediaBanner {
  readonly cfg = input.required<BannerCfg>();
  readonly compact = input(false);
  private readonly site = inject(SiteService).site;
  protected readonly reduced = reducedMotion();
  protected readonly playing = signal(true);
  protected readonly cx = cx;
  protected readonly fill = computed(() => (this.cfg().video ? "h-full" : ""));
  protected t(x: string | undefined): string {
    return fillTokens(x ?? "", this.site());
  }
}

/* The block's shape. A 21:9 strip is too low for words on a phone, so phones get 16:9. */
const ASPECT: Record<string, string> = {
  "21/9": "aspect-video sm:aspect-[21/9]",
  "16/9": "aspect-video",
  "4/3": "aspect-[4/3]",
  "1/1": "aspect-square",
  "4/5": "aspect-[4/5]",
};
/** Contained blocks keep the whole picture in view on large screens: tall shapes get narrower instead of taller. */
const CAP: Record<string, string> = { "21/9": "", "16/9": "", "4/3": "lg:max-w-[880px]", "1/1": "lg:max-w-[600px]", "4/5": "lg:max-w-[500px]" };
/** Beside the words (large screens): the picture's column. */
const SPLIT: Record<string, string> = {
  "4/3": "lg:grid-cols-[minmax(0,620px)_minmax(0,1fr)]",
  "1/1": "lg:grid-cols-[minmax(0,500px)_minmax(0,1fr)]",
  "4/5": "lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]",
};

/** The heading, text and button of a media block, in one of three sizes. */
@Component({
  selector: "pc-media-words",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (cfg().heading) {
      <h2 [class]="cx('max-w-2xl font-bold', size() === 'overlay' && 'line-clamp-2 text-xl sm:line-clamp-none sm:text-4xl', size() === 'side' && 'text-3xl xl:text-4xl', size() === 'caption' && 'text-xl sm:text-2xl')">{{ t(cfg().heading) }}</h2>
    }
    @if (cfg().text) {
      <p [class]="cx('max-w-xl', light() ? 'text-white/90' : 'text-ink-soft', size() === 'overlay' ? 'line-clamp-2 text-sm sm:line-clamp-3 sm:text-lg' : size() === 'side' ? 'text-lg' : 'text-[15px]')">{{ t(cfg().text) }}</p>
    }
    @if (cfg().cta && (size() !== "caption" || cfg().link)) {
      <span [class]="cx('pc-press mt-1.5 inline-flex items-center rounded-lg bg-marigold font-semibold text-ink shadow-sm transition-colors group-hover:bg-marigold-dark',
        size() === 'overlay' ? 'px-4 py-2 text-sm sm:mt-3 sm:px-5 sm:py-2.5 sm:text-base' : 'px-5 py-2.5 text-[15px]', center() ? 'self-center' : 'self-start')">{{ t(cfg().cta) }}</span>
    }
  `,
})
export class MediaWords {
  readonly cfg = input.required<MediaCfg>();
  readonly light = input.required<boolean>();
  readonly center = input.required<boolean>();
  readonly size = input.required<"overlay" | "side" | "caption">();
  private readonly site = inject(SiteService).site;
  protected readonly cx = cx;
  protected t(x: string | undefined): string {
    return fillTokens(x ?? "", this.site());
  }
}

/** The "Image or video block": a picture or video with optional words, a button and a link, in five shapes. */
@Component({
  selector: "pc-media-block",
  imports: [PcLink, MediaFill, VideoToggle, MediaWords, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #media>
      <div [class]="cx('relative overflow-hidden bg-mist', ASPECT[aspect()], roundCls(), full() && 'lg:max-h-[min(80vh,760px)] lg:w-full')">
        <pc-media-fill [image]="image()" [video]="video()" [alt]="hasWords() ? '' : name()" [playing]="playing()"
          mediaClass="absolute inset-0 transition-transform duration-500 motion-safe:group-hover:scale-[1.02]" />
        @if (hasWords()) {
          <div [class]="overlayCls()"><pc-media-words [cfg]="cfg()" [light]="light()" [center]="center()" size="overlay" /></div>
        }
      </div>
    </ng-template>
    <ng-template #wrap let-tpl let-cls="cls" let-label="label">
      @if (cfg().link) {
        @if (cfg().link!.startsWith("https://")) {
          <a [href]="cfg().link" target="_blank" rel="noopener noreferrer" [attr.aria-label]="label || null" [class]="cx('group block', cls)"><ng-container *ngTemplateOutlet="tpl" /></a>
        } @else {
          <a [pcLink]="cfg().link!" [attr.aria-label]="label || null" [class]="cx('group block', cls)"><ng-container *ngTemplateOutlet="tpl" /></a>
        }
      } @else {
        <div [class]="cls || null"><ng-container *ngTemplateOutlet="tpl" /></div>
      }
    </ng-template>
    <ng-template #side>
      <div [class]="cx('flex flex-col gap-3 px-6 py-10 xl:px-14', center() && 'items-center text-center')">
        <pc-media-words [cfg]="cfg()" [light]="false" [center]="center()" size="side" />
      </div>
    </ng-template>
    @if (image() || video()) {
      @if (cfg().controls && video()) {
        <section [attr.aria-label]="name()" [class]="cx(bleed(), !full() && cx('mx-auto w-full', CAP[aspect()]))">
          <div [class]="cx('relative overflow-hidden bg-black', ASPECT[aspect()], roundCls(), full() && 'lg:max-h-[min(80vh,760px)] lg:w-full')">
            <video [src]="video()" [attr.poster]="image() || null" controls playsinline preload="metadata" [attr.aria-label]="name()" class="absolute inset-0 h-full w-full object-contain"></video>
          </div>
          @if (hasWords()) {
            <div [class]="cx('flex flex-col gap-1.5 pt-3', center() && 'items-center text-center', full() && 'px-3 sm:px-4')">
              <pc-media-words [cfg]="cfg()" [light]="false" [center]="center()" size="caption" />
              @if (cfg().cta && cfg().link) {
                @if (cfg().link!.startsWith("https://")) {
                  <a [href]="cfg().link" target="_blank" rel="noopener noreferrer" [class]="cx('pc-press mt-1 inline-flex items-center rounded-lg bg-marigold px-5 py-2.5 text-[15px] font-semibold text-ink hover:bg-marigold-dark', center() ? 'self-center' : 'self-start')">{{ cfg().cta }}</a>
                } @else {
                  <a [pcLink]="cfg().link!" [class]="cx('pc-press mt-1 inline-flex items-center rounded-lg bg-marigold px-5 py-2.5 text-[15px] font-semibold text-ink hover:bg-marigold-dark', center() ? 'self-center' : 'self-start')">{{ cfg().cta }}</a>
                }
              }
            </div>
          }
        </section>
      } @else if (split()) {
        <section [attr.aria-label]="name()" [class]="cx('shop-panel overflow-hidden lg:grid lg:items-center', SPLIT[aspect()])">
          <div class="relative">
            <ng-container *ngTemplateOutlet="wrap; context: { $implicit: media, cls: '', label: name() }" />
            @if (showToggle()) {<pc-video-toggle [playing]="playing()" (toggle)="playing.set(!playing())" toggleClass="absolute right-3 top-3 z-10" />}
          </div>
          <ng-container *ngTemplateOutlet="wrap; context: { $implicit: side, cls: 'hidden lg:block', label: '' }" />
        </section>
      } @else {
        <section [attr.aria-label]="name()" [class]="cx('relative', bleed(), !full() && cx('mx-auto w-full', CAP[aspect()]))">
          <ng-container *ngTemplateOutlet="wrap; context: { $implicit: media, cls: '', label: hasWords() ? '' : name() }" />
          @if (showToggle()) {<pc-video-toggle [playing]="playing()" (toggle)="playing.set(!playing())" toggleClass="absolute right-3 top-3 z-10" />}
        </section>
      }
    }
  `,
})
export class MediaBlock {
  readonly cfg = input.required<MediaCfg>();
  readonly title = input<string | undefined>(undefined);
  protected readonly reduced = reducedMotion();
  protected readonly playing = signal(true);
  protected readonly cx = cx;
  protected readonly ASPECT = ASPECT;
  protected readonly CAP = CAP;
  protected readonly SPLIT = SPLIT;
  protected readonly image = computed(() => this.cfg().image || "");
  protected readonly video = computed(() => this.cfg().video || "");
  protected readonly aspect = computed(() => (ASPECT[this.cfg().aspect ?? ""] ? (this.cfg().aspect as string) : "16/9"));
  protected readonly full = computed(() => this.cfg().width === "full");
  protected readonly light = computed(() => this.cfg().tone !== "dark");
  protected readonly center = computed(() => this.cfg().align === "center");
  protected readonly portrait = computed(() => this.aspect() === "1/1" || this.aspect() === "4/5");
  protected readonly hasWords = computed(() => Boolean(this.cfg().heading || this.cfg().text || this.cfg().cta));
  protected readonly name = computed(() => this.cfg().heading || this.title() || "Featured");
  protected readonly roundCls = computed(() => (this.full() ? "" : "rounded-xl"));
  protected readonly bleed = computed(() => (this.full() ? "-mx-3 sm:-mx-4" : ""));
  protected readonly split = computed(() => !this.full() && this.hasWords() && Boolean(SPLIT[this.aspect()]));
  protected readonly showToggle = computed(() => Boolean(this.video()) && !this.reduced());
  protected readonly overlayCls = computed(() => cx("absolute inset-0 flex flex-col gap-2 p-4 sm:gap-2.5 sm:p-10",
    this.portrait() ? "justify-end" : "justify-center",
    this.center() ? "items-center text-center" : "items-start",
    this.light() ? cx("text-white", this.portrait() ? "bg-gradient-to-t from-ink/80 via-ink/30 to-transparent" : this.center() ? "bg-ink/45" : "bg-gradient-to-r from-ink/75 via-ink/35 to-transparent") : "text-ink",
    this.split() && "lg:hidden"));
}
