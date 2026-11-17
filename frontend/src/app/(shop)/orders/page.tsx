"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ButtonLink, EmptyState, PageLoader, Pagination, ProductImage, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { date, rupees, SUB_STATUS_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { OrderSummary, Paged } from "@/lib/types";

function overall(o: OrderSummary): { status: string; label: string } {
  if (o.status === "pending_payment") return { status: "pending_payment", label: "Awaiting payment" };
  if (o.status === "cancelled") return { status: "cancelled", label: "Cancelled" };
  const live = o.sub_statuses.filter((s) => s !== "cancelled");
  if (live.every((s) => s === "delivered")) return { status: "delivered", label: "Delivered" };
  if (live.some((s) => s === "shipped")) return { status: "shipped", label: "On the way" };
  return { status: live[0] ?? "placed", label: SUB_STATUS_LABEL[live[0] ?? "placed"] };
}

export default function OrdersPage() {
  const { user, ready } = useSession();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<OrderSummary> | null>(null);

  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/orders");
  }, [ready, user, router]);
  useEffect(() => {
    if (user) api<Paged<OrderSummary>>("/api/orders", { query: { page } }).then(setData).catch(() => setData({ items: [], total: 0, page: 1, page_size: 10 }));
  }, [user, page]);

  if (!data) return <PageLoader />;
  if (!data.items.length) return <EmptyState title="No orders yet" body="When you place an order it will appear here." action={<ButtonLink href="/">Start shopping</ButtonLink>} />;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="px-1 text-2xl font-semibold">Your orders</h1>
      {data.items.map((o) => {
        const st = overall(o);
        return (
          <Link key={o.id} href={`/orders/${o.id}`} className="flex flex-col gap-3 rounded-xl bg-white p-4 hover:ring-2 hover:ring-peacock/20 sm:flex-row sm:items-center">
            <div className="flex -space-x-3">
              {o.items.slice(0, 3).map((it, i) => (
                <ProductImage key={i} src={it.image} alt={it.title} className="h-16 w-16 rounded-lg border-2 border-white bg-white" />
              ))}
            </div>
            <div className="flex-1">
              <p className="line-clamp-1 font-medium">{o.items[0]?.title}{o.item_count > 1 ? ` and ${o.item_count - 1} more` : ""}</p>
              <p className="text-sm text-ink-faint">Order {o.number}, placed {date(o.created_at)}</p>
            </div>
            <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
              <span className="font-display text-lg font-bold">{rupees(o.grand_total)}</span>
              <StatusPill status={st.status} label={st.label} />
            </div>
          </Link>
        );
      })}
      <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
    </div>
  );
}
