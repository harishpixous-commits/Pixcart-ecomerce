import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SearchView } from "@/components/search-view";
import { PageLoader } from "@/components/ui";
import { date } from "@/lib/format";
import { loadSiteServer, serverGet } from "@/lib/server-api";

type Store = { name: string; slug: string; description: string; city: string; state: string; since: string | null; product_count: number };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const s = await serverGet<Store>(`/api/catalog/stores/${encodeURIComponent(slug)}`).catch(() => null);
  return { title: s ? `${s.name} store` : "Store" };
}

export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await serverGet<Store>(`/api/catalog/stores/${encodeURIComponent(slug)}`);
  const brand = (await loadSiteServer()).brand_name;
  if (!s) notFound();
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl bg-peacock p-6 text-white">
        <h1 className="text-3xl font-bold">{s.name}</h1>
        <p className="text-white/80">{s.city}, {s.state}{s.since ? `. Selling on ${brand} since ${date(s.since)}` : ""}. {s.product_count} products.</p>
        {s.description && <p className="mt-2 max-w-2xl text-white/90">{s.description}</p>}
      </section>
      <Suspense fallback={<PageLoader />}>
        <StoreProducts slug={s.slug} />
      </Suspense>
    </div>
  );
}

function StoreProducts({ slug }: { slug: string }) {
  return <SearchView seller={slug} />;
}
