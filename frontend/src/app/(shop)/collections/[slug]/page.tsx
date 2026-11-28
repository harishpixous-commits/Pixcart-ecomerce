"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/product";
import { api, ApiError } from "@/lib/api";
import type { ProductCard } from "@/lib/types";

type Data = { slug: string; title: string; description: string; image_url: string; products: ProductCard[] };

export default function CollectionPage() {
  const { slug } = useParams<{ slug: string }>();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Data>(`/api/catalog/collections/${slug}`).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load this collection"));
  }, [slug]);
  if (error) return <p className="rounded-xl bg-white p-6 text-ink-soft">{error}</p>;
  if (!d) return <p className="rounded-xl bg-white p-6 text-ink-soft">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-xl bg-white p-4 sm:p-5">
        {d.image_url && /* eslint-disable-next-line @next/next/no-img-element */ <img src={d.image_url} alt="" className="mb-3 max-h-48 w-full rounded-lg object-cover" />}
        <h1 className="text-2xl font-semibold">{d.title}</h1>
        {d.description && <p className="mt-1 text-ink-soft">{d.description}</p>}
      </header>
      {d.products.length ? <ProductGrid items={d.products} showAdd /> : <p className="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p>}
    </div>
  );
}
