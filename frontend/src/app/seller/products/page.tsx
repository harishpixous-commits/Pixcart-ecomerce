"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { ButtonLink, EmptyState, Input, PageLoader, Pagination, ProductImage, StatusPill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";
import type { Paged } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type Row = { id: string; title: string; slug: string; status: string; rejection_reason: string; image: string; price_from: number; mrp_from: number; total_stock: number; updated_at: string };

const STATUS_LABEL: Record<string, string> = { approved: "Live", pending: "In review", rejected: "Needs changes", draft: "Draft", archived: "Archived" };

function List() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "";
  const lowStock = sp.get("low_stock") === "1";
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<Row> | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<Paged<Row>>("/api/seller/products", { query: { status: status || undefined, q, page, low_stock: lowStock || undefined } }).then(setData).catch(quietly);
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page, lowStock]);

  const counts = data?.status_counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div>
      <PageHeader title="Products" actions={<><ExportButton scope="seller" name="products" status={status || undefined} dated={false} /><ButtonLink href="/seller/products/import" variant="secondary">Bulk upload</ButtonLink><ButtonLink href="/seller/products/new">Add a product</ButtonLink></>} />
      <Tabs
        value={lowStock ? "low" : status}
        onChange={(v) => { setPage(1); router.push(v === "low" ? "/seller/products?low_stock=1" : v ? `/seller/products?status=${v}` : "/seller/products"); }}
        items={[
          { value: "", label: "All", count: total },
          ...["approved", "pending", "rejected", "draft", "archived"].map((s) => ({ value: s, label: STATUS_LABEL[s], count: counts[s] ?? 0 })),
          { value: "low", label: "Low stock" },
        ]}
      />
      <Input placeholder="Search by title or SKU" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search products" />
      {!data ? (
        <PageLoader />
      ) : data.items.length === 0 ? (
        <EmptyState title={total ? "Nothing here" : "No products yet"} body={total ? "Try another tab or search." : "Add your first product to start selling."} action={!total ? <ButtonLink href="/seller/products/new">Add a product</ButtonLink> : undefined} />
      ) : (
        <>
          <Table head={["Product", "Price", "Stock", "Status", "Updated"]}>
            {data.items.map((p) => (
              <tr key={p.id} className="hover:bg-mist/60">
                <td className="px-4 py-3">
                  <Link href={`/seller/products/${p.id}`} className="flex items-center gap-3">
                    <ProductImage src={p.image} alt="" className="h-12 w-12 shrink-0 rounded" />
                    <span>
                      <span className="line-clamp-1 font-medium hover:text-peacock">{p.title}</span>
                      {p.status === "rejected" && p.rejection_reason && <span className="line-clamp-1 text-sm text-vermilion">{p.rejection_reason}</span>}
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-3">{p.price_from ? rupees(p.price_from) : "—"}</td>
                <td className={p.total_stock <= 5 ? "px-4 py-3 font-semibold text-vermilion" : "px-4 py-3"}>{p.total_stock}</td>
                <td className="px-4 py-3"><StatusPill status={p.status} label={STATUS_LABEL[p.status]} /></td>
                <td className="px-4 py-3 text-sm text-ink-faint">{date(p.updated_at)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <List />
    </Suspense>
  );
}
