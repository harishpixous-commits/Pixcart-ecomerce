"use client";

/** A wishlist someone shared with a private link. No sign-in needed. */

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/product";
import { ButtonLink, EmptyState, PageLoader } from "@/components/ui";
import { api } from "@/lib/api";
import type { ProductCard } from "@/lib/types";

export default function SharedWishlistPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<{ owner: string; items: ProductCard[] } | null | "gone">(null);
  useEffect(() => {
    api<{ owner: string; items: ProductCard[] }>(`/api/wishlist/shared/${encodeURIComponent(token)}`).then(setData).catch(() => setData("gone"));
  }, [token]);
  if (data === null) return <PageLoader />;
  if (data === "gone") {
    return <EmptyState title="This wishlist is not shared any more" body="The link was switched off or is not right." action={<ButtonLink href="/">Browse products</ButtonLink>} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <h1 className="px-1 text-2xl font-semibold">{data.owner ? `${data.owner}'s wishlist` : "A shared wishlist"} <span className="text-base font-normal text-ink-faint">({data.items.length})</span></h1>
      {data.items.length === 0 ? <EmptyState title="Nothing here right now" body="The products on this list are not available at the moment." /> : <ProductGrid items={data.items} dense />}
    </div>
  );
}
