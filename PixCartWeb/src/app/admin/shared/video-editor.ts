/*
 * Videos for a listing. The browser takes a still frame (the poster) and the length from the file, so the server
 * stores the video as uploaded (MP4 or WebM) without any conversion. Port of components/video-editor.tsx:
 *   <pc-video-editor [videos]="draft()" (videosChange)="draft.set($event)" videoUploadPath="..." imageUploadPath="..." [maxVideos]="3" [maxMb]="50" />
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, input, output, signal } from "@angular/core";
import { ArrowLeft, ArrowRight, Film, Play, X } from "lucide-angular";
import { api, ApiError, uploadWithProgress } from "../../core/api";
import type { ProductVideo } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { ErrorNote, Input } from "../../shared/ui/ui";

const dur = (s: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

export async function frameAndLength(file: File): Promise<{ poster: File | null; duration: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise<void>((ok, fail) => { video.onloadedmetadata = () => ok(); video.onerror = () => fail(new Error("unreadable")); });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    video.currentTime = Math.min(1, duration * 0.2);
    await new Promise<void>((ok) => { video.onseeked = () => ok(); setTimeout(ok, 3000); });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = canvas.width >= 200 && canvas.height >= 200 ? await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85)) : null;
    return { poster: blob ? new File([blob], "poster.jpg", { type: "image/jpeg" }) : null, duration };
  } catch {
    return { poster: null, duration: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

@Component({
  selector: "pc-video-editor",
  imports: [Icon, ErrorNote, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3" },
  template: `
    <pc-error-note [message]="error()" />
    <div class="flex flex-wrap gap-3">
      @for (v of videos(); track v.url; let i = $index) {
        <div class="w-48 overflow-hidden rounded-lg border border-line bg-white">
          <a [href]="v.url" target="_blank" rel="noopener noreferrer" class="relative block aspect-video bg-ink" aria-label="Play this video in a new tab">
            @if (v.poster_url) {
              <img [src]="v.poster_url" alt="" class="h-full w-full object-cover" />
            } @else {
              <video [src]="v.url + '#t=0.5'" preload="metadata" [muted]="true" class="h-full w-full object-cover"></video>
            }
            <svg [pcIcon]="Play" class="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
            @if (v.duration_s > 0) {<span class="absolute bottom-1 right-1 rounded bg-ink/80 px-1 text-xs text-white">{{ dur(v.duration_s) }}</span>}
          </a>
          <div class="p-1.5">
            <input pcInput [value]="v.title" maxlength="120" placeholder="Title (optional)" [disabled]="disabled()" [attr.aria-label]="'Title of video ' + (i + 1)" class="h-8 text-sm"
              (input)="setTitle(i, $any($event.target).value)" />
            @if (!disabled()) {
              <div class="mt-1 flex justify-between">
                <button type="button" (click)="move(i, -1)" [disabled]="i === 0" aria-label="Move left" class="p-1 disabled:opacity-30"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" /></button>
                <button type="button" (click)="remove(i)" aria-label="Remove video" class="p-1 text-vermilion"><svg [pcIcon]="X" class="h-4 w-4" /></button>
                <button type="button" (click)="move(i, 1)" [disabled]="i === videos().length - 1" aria-label="Move right" class="p-1 disabled:opacity-30"><svg [pcIcon]="ArrowRight" class="h-4 w-4" /></button>
              </div>
            }
          </div>
        </div>
      }
      @if (!disabled() && videos().length < maxVideos()) {
        <label [class]="'flex aspect-video w-48 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock ' + (progress() === null ? 'cursor-pointer hover:border-peacock' : '')">
          <svg [pcIcon]="Film" class="h-6 w-6" />
          {{ progress() === null ? "Add video" : "Uploading " + round(progress()! * 100) + "%" }}
          @if (progress() !== null) {<span class="h-1.5 w-32 overflow-hidden rounded-full bg-line"><span class="block h-full bg-peacock" [style.width.%]="progress()! * 100"></span></span>}
          <input type="file" accept="video/mp4,video/webm" class="sr-only" [disabled]="progress() !== null" (change)="picked($event)" />
        </label>
      }
    </div>
    <p class="text-xs text-ink-faint">MP4 or WebM, up to {{ maxMb() }} MB, at most {{ maxVideos() }}. Short clips (under a minute) showing the product in use work best. The first frame shown is taken from the video.</p>
  `,
})
export class VideoEditor {
  readonly videos = input.required<ProductVideo[]>();
  readonly videoUploadPath = input.required<string>();
  readonly imageUploadPath = input.required<string>();
  readonly maxVideos = input.required<number>();
  readonly maxMb = input.required<number>();
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly videosChange = output<ProductVideo[]>();
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly ArrowRight = ArrowRight;
  protected readonly Film = Film;
  protected readonly Play = Play;
  protected readonly X = X;
  protected readonly dur = dur;
  protected readonly round = Math.round;
  protected readonly progress = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);

  protected picked(e: Event): void {
    const el = e.target as HTMLInputElement;
    const f = el.files?.[0];
    el.value = "";
    if (f) void this.add(f);
  }

  private async add(file: File): Promise<void> {
    this.error.set(null);
    if (!/^video\/(mp4|webm)$/.test(file.type) && !/\.(mp4|webm)$/i.test(file.name)) {
      this.error.set("Choose an MP4 or WebM video.");
      return;
    }
    const maxMb = this.maxMb();
    if (file.size > maxMb * 1024 * 1024) {
      this.error.set(`This video is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${maxMb} MB. Export it smaller (720p is plenty).`);
      return;
    }
    this.progress.set(0);
    try {
      const { poster, duration } = await frameAndLength(file);
      const up = await uploadWithProgress<{ url: string }>(this.videoUploadPath(), file, (f) => this.progress.set(f));
      let poster_url = "";
      if (poster) {
        const form = new FormData();
        form.append("file", poster);
        poster_url = (await api<{ url: string }>(this.imageUploadPath(), { method: "POST", form }).catch(() => ({ url: "" }))).url;
      }
      this.videosChange.emit([...this.videos(), { url: up.url, poster_url, title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 120), duration_s: Math.round(duration) }]);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "The upload failed. Try again.");
    } finally {
      this.progress.set(null);
    }
  }

  protected setTitle(i: number, title: string): void {
    this.videosChange.emit(this.videos().map((x, k) => (k === i ? { ...x, title } : x)));
  }

  protected remove(i: number): void {
    this.videosChange.emit(this.videos().filter((_, k) => k !== i));
  }

  protected move(i: number, d: -1 | 1): void {
    const videos = this.videos();
    const j = i + d;
    if (j < 0 || j >= videos.length) return;
    const next = [...videos];
    [next[i], next[j]] = [next[j], next[i]];
    this.videosChange.emit(next);
  }
}
