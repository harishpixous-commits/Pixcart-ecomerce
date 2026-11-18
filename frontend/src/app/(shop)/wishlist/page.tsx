"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/product";
import { ButtonLink, EmptyState, PageLoader } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { ProductCard } from "@/lib/types";
import { useWishlist } from "@/lib/wishlist";

export default function WishlistPage() {
  const { user, ready } = useSession();
  const { ids } = useWishlist();
  const router = useRouter();
  const [items, setItems] = useState<ProductCard[] | null>(null);
  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/wishlist");
    if (user) api<{ items: ProductCard[] }>("/api/wishlist").then((r) => setItems(r.items)).catch(quietly);
  }, [ready, user, router]);
  if (!items) return <PageLoader />;
  const shown = items.filter((p) => ids.has(p.id));
  return (
    <div className="flex flex-col gap-3">
      <h1 className="px-1 text-2xl font-semibold">Your wishlist <span className="text-base font-normal text-ink-faint">({shown.length})</span></h1>
      {shown.length === 0 ? (
        <EmptyState title="Nothing saved yet" body="Tap the heart on any product to save it here for later." action={<ButtonLink href="/">Browse products</ButtonLink>} />
      ) : (
        <ProductGrid items={shown} dense />
      )}
    </div>
  );
}
