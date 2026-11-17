"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Sparkles } from "lucide-react";
import { Button, ErrorNote, Modal, PageLoader, Pill, StatusPill, Textarea, useToast } from "@/components/ui";
import { useSite } from "@/lib/site";
import { api, ApiError } from "@/lib/api";
import { pct, rupees } from "@/lib/format";
import type { SellerProduct } from "@/lib/types";

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
        <div className="mb-4 flex flex-wrap gap-3">
          {p.images.map((src) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt="" className="h-40 w-40 rounded-lg border border-line object-contain" />
          ))}
        </div>
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
