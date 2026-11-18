import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductRail } from "@/components/product";
import { ProductReviews } from "@/components/reviews";
import { serverGet } from "@/lib/server-api";
import type { ProductPage } from "@/lib/types";
import { BuyBox, Gallery } from "./buy-box";


async function load(slug: string) {
  return serverGet<ProductPage>(`/api/catalog/products/${encodeURIComponent(slug)}`, 30);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await load(slug).catch(() => null);
  if (!p) return { title: "Product not found" };
  const description = (p.description || p.title).slice(0, 160);
  return {
    title: p.title,
    description,
    alternates: { canonical: `/p/${p.slug}` },
    openGraph: { title: p.title, description, images: p.images.slice(0, 1) },
  };
}

export default async function ProductPageView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await load(slug);
  if (!p) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    image: p.images,
    description: p.description,
    brand: p.brand ? { "@type": "Brand", name: p.brand } : undefined,
    aggregateRating: p.rating_count ? { "@type": "AggregateRating", ratingValue: p.rating_avg, reviewCount: p.rating_count } : undefined,
    offers: {
      "@type": "Offer",
      priceCurrency: "INR",
      price: (p.price / 100).toFixed(2),
      availability: p.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      seller: { "@type": "Organization", name: p.seller.name },
    },
  };

  return (
    <div className="flex flex-col gap-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <nav className="text-sm text-ink-faint" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-peacock">Home</Link>
        {p.breadcrumbs.map((b) => (
          <span key={b.slug}>
            {" / "}
            <Link href={`/c/${b.slug}`} className="hover:text-peacock">{b.name}</Link>
          </span>
        ))}
      </nav>
      <div className="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-[1.15fr_1fr]">
        {/* z-10: the hover-zoom panel opens over the product details, under the site header (z-30). */}
        <div className="relative z-10 lg:sticky lg:top-36 lg:self-start">
          <Gallery images={p.images} videos={p.videos} title={p.title} />
        </div>
        <BuyBox p={p} />
      </div>

      {(p.highlights.length > 0 || p.description) && (
        <section className="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-2">
          {p.highlights.length > 0 && (
            <div>
              <h2 className="mb-2 text-xl font-semibold">Highlights</h2>
              <ul className="list-disc space-y-1 pl-5 text-ink-soft">
                {p.highlights.map((h) => <li key={h}>{h}</li>)}
              </ul>
            </div>
          )}
          {p.description && (
            <div>
              <h2 className="mb-2 text-xl font-semibold">Description</h2>
              <p className="max-w-prose whitespace-pre-line text-ink-soft">{p.description}</p>
            </div>
          )}
        </section>
      )}

      {Object.keys(p.specs).length > 0 && (
        <section className="rounded-xl bg-white p-4 sm:p-6">
          <h2 className="mb-3 text-xl font-semibold">Specifications</h2>
          <dl className="grid max-w-3xl grid-cols-[minmax(120px,200px)_1fr] gap-x-6 gap-y-2 text-[15px]">
            {Object.entries(p.specs).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-faint">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <ProductReviews slug={p.slug} />
      <ProductRail title="Similar products" items={p.similar} />
    </div>
  );
}
