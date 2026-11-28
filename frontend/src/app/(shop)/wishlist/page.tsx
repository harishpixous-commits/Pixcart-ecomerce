"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/product";
import { Button, ButtonLink, EmptyState, PageLoader, useToast } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { ProductCard } from "@/lib/types";
import { useWishlist } from "@/lib/wishlist";

function SharePanel() {
  const toast = useToast();
  const [st, setSt] = useState<{ enabled: boolean; token: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ enabled: boolean; token: string | null }>("/api/wishlist/share").then(setSt).catch(quietly); }, []);
  if (!st?.enabled) return null;
  const link = st.token ? `${window.location.origin}/wishlist/shared/${st.token}` : "";
  async function change(on: boolean) {
    setBusy(true);
    try {
      setSt(await api<{ enabled: boolean; token: string | null }>("/api/wishlist/share", { method: on ? "POST" : "DELETE" }));
    } catch {
      toast("Could not change sharing. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white p-3 text-sm" data-testid="wishlist-share">
      {st.token ? (
        <>
          <p className="text-ink-soft">Anyone with this link can see your saved products and your first name.</p>
          <input readOnly value={link} aria-label="Share link" className="w-full rounded-lg border border-line px-2 py-1.5" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(link).then(() => toast("Link copied"))}>Copy link</Button>
            <Button variant="ghost" loading={busy} onClick={() => change(false)}>Stop sharing</Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" loading={busy} onClick={() => change(true)} className="self-start">Share my wishlist</Button>
      )}
    </div>
  );
}

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
      <SharePanel />
      {shown.length === 0 ? (
        <EmptyState title="Nothing saved yet" body="Tap the heart on any product to save it here for later." action={<ButtonLink href="/">Browse products</ButtonLink>} />
      ) : (
        <ProductGrid items={shown} dense />
      )}
    </div>
  );
}
