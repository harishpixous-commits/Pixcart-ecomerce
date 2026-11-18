"use client";

import { ArrowLeft, ArrowRight, Film, Play, X } from "lucide-react";
import { useState } from "react";
import { ErrorNote, Input } from "@/components/ui";
import { api, ApiError, uploadWithProgress } from "@/lib/api";
import type { ProductVideo } from "@/lib/types";

/*
 * Videos for a listing. The browser takes a still frame (the poster) and the length from the file, so the server
 * stores the video as uploaded (MP4 or WebM) without any conversion.
 */

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

export function VideoEditor({ videos, onChange, videoUploadPath, imageUploadPath, maxVideos, maxMb, disabled }: {
  videos: ProductVideo[]; onChange: (v: ProductVideo[]) => void; videoUploadPath: string; imageUploadPath: string;
  maxVideos: number; maxMb: number; disabled?: boolean;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(file: File) {
    setError(null);
    if (!/^video\/(mp4|webm)$/.test(file.type) && !/\.(mp4|webm)$/i.test(file.name)) {
      setError("Choose an MP4 or WebM video.");
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      setError(`This video is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${maxMb} MB. Export it smaller (720p is plenty).`);
      return;
    }
    setProgress(0);
    try {
      const { poster, duration } = await frameAndLength(file);
      const up = await uploadWithProgress<{ url: string }>(videoUploadPath, file, (f) => setProgress(f));
      let poster_url = "";
      if (poster) {
        const form = new FormData();
        form.append("file", poster);
        poster_url = (await api<{ url: string }>(imageUploadPath, { method: "POST", form }).catch(() => ({ url: "" }))).url;
      }
      onChange([...videos, { url: up.url, poster_url, title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 120), duration_s: Math.round(duration) }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The upload failed. Try again.");
    } finally {
      setProgress(null);
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= videos.length) return;
    const next = [...videos];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorNote message={error} />
      <div className="flex flex-wrap gap-3">
        {videos.map((v, i) => (
          <div key={v.url} className="w-48 overflow-hidden rounded-lg border border-line bg-white">
            <a href={v.url} target="_blank" rel="noopener noreferrer" className="relative block aspect-video bg-ink" aria-label="Play this video in a new tab">
              {v.poster_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={v.poster_url} alt="" className="h-full w-full object-cover" />
                : <video src={`${v.url}#t=0.5`} preload="metadata" muted className="h-full w-full object-cover" />}
              <Play className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
              {v.duration_s > 0 && <span className="absolute bottom-1 right-1 rounded bg-ink/80 px-1 text-xs text-white">{dur(v.duration_s)}</span>}
            </a>
            <div className="p-1.5">
              <Input value={v.title} maxLength={120} placeholder="Title (optional)" disabled={disabled} aria-label={`Title of video ${i + 1}`} className="h-8 text-sm"
                onChange={(e) => onChange(videos.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
              {!disabled && (
                <div className="mt-1 flex justify-between">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move left" className="p-1 disabled:opacity-30"><ArrowLeft className="h-4 w-4" /></button>
                  <button type="button" onClick={() => onChange(videos.filter((_, k) => k !== i))} aria-label="Remove video" className="p-1 text-vermilion"><X className="h-4 w-4" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === videos.length - 1} aria-label="Move right" className="p-1 disabled:opacity-30"><ArrowRight className="h-4 w-4" /></button>
                </div>
              )}
            </div>
          </div>
        ))}
        {!disabled && videos.length < maxVideos && (
          <label className={`flex aspect-video w-48 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock ${progress === null ? "cursor-pointer hover:border-peacock" : ""}`}>
            <Film className="h-6 w-6" />
            {progress === null ? "Add video" : `Uploading ${Math.round(progress * 100)}%`}
            {progress !== null && <span className="h-1.5 w-32 overflow-hidden rounded-full bg-line"><span className="block h-full bg-peacock" style={{ width: `${progress * 100}%` }} /></span>}
            <input type="file" accept="video/mp4,video/webm" className="sr-only" disabled={progress !== null}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) add(f); }} />
          </label>
        )}
      </div>
      <p className="text-xs text-ink-faint">MP4 or WebM, up to {maxMb} MB, at most {maxVideos}. Short clips (under a minute) showing the product in use work best. The first frame shown is taken from the video.</p>
    </div>
  );
}
