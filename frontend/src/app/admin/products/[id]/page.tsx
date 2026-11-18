"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { ArrowLeft, ArrowRight, ImagePlus, Sparkles, X } from "lucide-react";
import { Button, ErrorNote, Modal, PageLoader, Pill, StatusPill, Textarea, useToast } from "@/components/ui";
import { useSite } from "@/lib/site";
import { api, ApiError } from "@/lib/api";
import { pct, rupees } from "@/lib/format";
import type { ProductVideo, SellerProduct } from "@/lib/types";
import { VideoEditor } from "@/components/video-editor";

const QUICK_REASONS = [
  "Images are blurry, watermarked or show another brand's logo",
  "Title does not describe the product accurately",
  "Prohibited or restricted item",
  "MRP looks inflated compared with the market price",
  "Wrong category or GST rate",
];

export default function AdminProductReview() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [p, setP] = useState<SellerProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const site = useSite();
  const [check, setCheck] = useState<{ risk: "low" | "medium" | "high"; issues: string[]; suggested_reason: string } | null>(null);
  const [checking, setChecking] = useState(false);
  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api(`/api/admin/products/${id}/ai-check`, { method: "POST" }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The AI check is not available");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    api<SellerProduct>(`/api/admin/products/${id}`).then(setP).catch((e) => setError(e.message));
  }, [id]);

  async function act(kind: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/products/${id}/${kind}`, { method: "POST", body: kind === "reject" ? { reason } : undefined });
      toast(kind === "approve" ? "Listing approved" : "Listing rejected");
      router.push("/admin/products");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
      setBusy(false);
    }
  }

  if (!p) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={p.title}
        sub={`${p.seller?.name} (${p.seller?.status}), ${p.category_name}`}
        actions={
          <>
            {site.features.ai && <Button variant="secondary" onClick={runCheck} loading={checking}><Sparkles className="h-4 w-4" /> AI check</Button>}
            {p.status === "pending" && <Button onClick={() => act("approve")} loading={busy}>Approve</Button>}
            {(p.status === "pending" || p.status === "approved") && <Button variant="danger" onClick={() => setRejecting(true)}>{p.status === "approved" ? "Take down" : "Reject"}</Button>}
            {p.status === "approved" && <Link href={`/p/${p.slug}`} target="_blank" className="inline-flex h-10 items-center px-3 font-semibold text-peacock">View on store</Link>}
          </>
        }
      />
      <ErrorNote message={error} />
      {check && (
        <section className={`rounded-xl border p-4 ${check.risk === "high" ? "border-vermilion bg-vermilion/5" : check.risk === "medium" ? "border-marigold bg-marigold-light" : "border-leaf bg-leaf-light"}`}>
          <div className="mb-1 flex items-center gap-2"><Sparkles className="h-4 w-4" /><p className="font-semibold">AI check</p><Pill tone={check.risk === "high" ? "red" : check.risk === "medium" ? "blue" : "green"}>{check.risk} risk</Pill></div>
          {check.issues.length ? <ul className="list-disc pl-5">{check.issues.map((i) => <li key={i}>{i}</li>)}</ul> : <p>No problems found.</p>}
          {check.suggested_reason && <Button size="sm" variant="ghost" className="mt-2" onClick={() => { setReason(check.suggested_reason); setRejecting(true); }}>Use as rejection reason</Button>}
          <p className="mt-1 text-xs text-ink-faint">Suggestions only. You make the decision.</p>
        </section>
      )}
      <div className="flex items-center gap-3"><StatusPill status={p.status} />{p.rejection_reason && <span className="text-vermilion">{p.rejection_reason}</span>}</div>
      <section className="rounded-xl bg-white p-5">
        <PhotoEditor key={p.images.join("|")} productId={id} images={p.images} onSaved={(next) => { setP(next); toast("Photos saved"); }} />
        <VideoSection key={(p.videos ?? []).map((v) => v.url + v.title).join("|")} productId={id} videos={p.videos ?? []} onSaved={(next) => { setP(next); toast("Videos saved"); }} />
        <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-[15px]">
          <dt className="text-ink-faint">Brand</dt><dd>{p.brand || "—"}</dd>
          <dt className="text-ink-faint">HSN / GST</dt><dd>{p.hsn_code} at {pct(p.gst_bps)}</dd>
          <dt className="text-ink-faint">Country of origin</dt><dd>{p.country_of_origin}</dd>
          <dt className="text-ink-faint">Return window</dt><dd>{p.return_window_days ? `${p.return_window_days} days` : "Not returnable"}</dd>
          <dt className="text-ink-faint">Highlights</dt><dd>{p.highlights.join("; ") || "—"}</dd>
          <dt className="text-ink-faint">Description</dt><dd className="whitespace-pre-line">{p.description}</dd>
          <dt className="text-ink-faint">Specifications</dt><dd>{Object.entries(p.specs).map(([k, v]) => `${k}: ${v}`).join("; ") || "—"}</dd>
        </dl>
      </section>
      <Table head={["Version", "SKU", "MRP", "Price", "Discount", "Stock", "On sale"]}>
        {p.variants.map((v) => (
          <tr key={v.id}>
            <td className="px-4 py-2">{v.label || "Single version"}</td>
            <td className="px-4 py-2 font-mono text-sm">{v.sku}</td>
            <td className="px-4 py-2">{rupees(v.mrp_paise)}</td>
            <td className="px-4 py-2">{rupees(v.price_paise)}</td>
            <td className={v.discount_pct >= 70 ? "px-4 py-2 font-semibold text-vermilion" : "px-4 py-2"}>{v.discount_pct}%</td>
            <td className="px-4 py-2">{v.stock}</td>
            <td className="px-4 py-2">{v.is_active ? "Yes" : "No"}</td>
          </tr>
        ))}
      </Table>
      <Modal open={rejecting} onClose={() => setRejecting(false)} title={p.status === "approved" ? "Take down listing" : "Reject listing"}>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {QUICK_REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} className="rounded-full bg-mist px-3 py-1 text-left text-sm hover:bg-peacock-light">{r}</button>
          ))}
        </div>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The seller sees this message" aria-label="Reason" />
        <Button className="mt-3" variant="buy" disabled={reason.trim().length < 5} loading={busy} onClick={() => act("reject")}>
          {p.status === "approved" ? "Take down" : "Reject"}
        </Button>
      </Modal>
    </div>
  );
}

const MAX_PHOTOS = 8;

/** Staff can correct a listing's photos: add, remove, reorder (first = main), then save. */
function PhotoEditor({ productId, images, onSaved }: { productId: string; images: string[]; onSaved: (p: SellerProduct) => void }) {
  const [draft, setDraft] = useState<string[]>(images);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.join("|") !== images.join("|");

  async function upload(files: FileList) {
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - draft.length)) {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ url: string }>("/api/admin/products/images", { method: "POST", form });
        setDraft((cur) => [...cur, r.url]);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<SellerProduct>(`/api/admin/products/${productId}/images`, { method: "PUT", body: { images: draft } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save photos");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Photos</h2>
        {dirty && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDraft(images)} disabled={saving}>Discard</Button>
            <Button size="sm" onClick={save} loading={saving} disabled={!draft.length || uploading}>Save photos</Button>
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      <div className="flex flex-wrap gap-3">
        {draft.map((src, i) => (
          <div key={src} className="relative h-40 w-40 overflow-hidden rounded-lg border border-line bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`Photo ${i + 1}`} className="h-full w-full object-contain" />
            {i === 0 && <span className="absolute left-1 top-1 rounded bg-peacock px-1.5 text-xs font-semibold text-white">Main</span>}
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-white/90 p-0.5">
              <button type="button" onClick={() => move(i, -1)} aria-label="Move left" className="p-1 disabled:opacity-30" disabled={i === 0}><ArrowLeft className="h-4 w-4" /></button>
              <button type="button" onClick={() => setDraft(draft.filter((x) => x !== src))} aria-label="Remove photo" className="p-1 text-vermilion"><X className="h-4 w-4" /></button>
              <button type="button" onClick={() => move(i, 1)} aria-label="Move right" className="p-1 disabled:opacity-30" disabled={i === draft.length - 1}><ArrowRight className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
        {draft.length < MAX_PHOTOS && (
          <label className="flex h-40 w-40 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock hover:border-peacock">
            <ImagePlus className="h-6 w-6" />
            {uploading ? "Uploading" : "Add photos"}
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={uploading} onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ""; }} />
          </label>
        )}
      </div>
      <p className="mt-2 text-sm text-ink-faint">Up to {MAX_PHOTOS} photos. The first one is the main photo. Changes go live when you save.</p>
    </div>
  );
}

/** Staff can add, retitle, reorder or remove a listing's videos. */
function VideoSection({ productId, videos, onSaved }: { productId: string; videos: ProductVideo[]; onSaved: (p: SellerProduct) => void }) {
  const site = useSite();
  const [draft, setDraft] = useState<ProductVideo[]>(videos);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(videos);
  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await api<SellerProduct>(`/api/admin/products/${productId}/videos`, { method: "PUT", body: { videos: draft } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save videos");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mb-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Videos</h2>
        {dirty && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDraft(videos)} disabled={saving}>Discard</Button>
            <Button size="sm" onClick={save} loading={saving}>Save videos</Button>
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      <VideoEditor videos={draft} onChange={setDraft} videoUploadPath="/api/admin/products/videos" imageUploadPath="/api/admin/products/images"
        maxVideos={site.gallery?.max_videos ?? 3} maxMb={site.gallery?.max_video_mb ?? 50} />
    </div>
  );
}
