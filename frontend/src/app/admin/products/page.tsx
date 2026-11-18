"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, ProductImage, StatusPill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime, rupees } from "@/lib/format";
import type { Paged } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type Row = { id: string; title: string; slug: string; status: string; seller_name: string; image: string; price_from: number; mrp_from: number; submitted_at: string | null };

function List() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "pending";
  const sellerId = sp.get("seller_id") ?? undefined;
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Paged<Row> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<Paged<Row>>("/api/admin/products", { query: { status: status || undefined, q, page, seller_id: sellerId } }).then(setD).catch(quietly), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page, sellerId]);
  const c = d?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Listings" sub="Approve new listings and edited content before customers see them." actions={<ExportButton scope="admin" name="products" status={status || undefined} dated={false} />} />
      <Tabs value={status} onChange={(v) => { setPage(1); router.push(`/admin/products?status=${v}`); }}
        items={[["pending", "To review"], ["approved", "Live"], ["rejected", "Rejected"], ["draft", "Drafts"], ["archived", "Archived"], ["", "All"]].map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }))} />
      <Input placeholder="Search titles" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search listings" />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="Nothing to review" /> : (
        <>
          <Table head={["Listing", "Seller", "Price", "Submitted", "Status"]}>
            {d.items.map((p) => (
              <tr key={p.id} className="hover:bg-mist/60">
                <td className="px-4 py-3">
                  <Link href={`/admin/products/${p.id}`} className="flex items-center gap-3">
                    <ProductImage src={p.image} alt="" className="h-12 w-12 shrink-0" />
                    <span className="line-clamp-2 font-medium text-peacock hover:underline">{p.title}</span>
                  </Link>
                </td>
                <td className="px-4 py-3">{p.seller_name}</td>
                <td className="px-4 py-3">{rupees(p.price_from)}</td>
                <td className="px-4 py-3 text-sm">{dateTime(p.submitted_at)}</td>
                <td className="px-4 py-3"><StatusPill status={p.status} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export default function AdminProducts() {
  return <Suspense fallback={<PageLoader />}><List /></Suspense>;
}
