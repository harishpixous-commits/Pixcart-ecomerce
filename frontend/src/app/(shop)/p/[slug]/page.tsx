import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductRail } from "@/components/product";
import { BoughtTogether } from "@/components/bought-together";
import { SponsoredRail } from "@/components/pdp";
import { ProductQuestions } from "@/components/qa";
import { ProductReviews } from "@/components/reviews";
import { date as fmtDate } from "@/lib/format";
import { serverGet } from "@/lib/server-api";
import type { ProductPage } from "@/lib/types";
import { BrowsingHistory, ProductMain } from "./buy-box";

async function load(slug: string) {
  return serverGet<ProductPage>(`/api/catalog/products/${encodeURIComponent(slug)}`, 30);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await load(slug).catch(() => null);
  if (!p) return { title: "Product not found" };
  const description = (p.seo_description || p.description || p.title).slice(0, 160);
  const title = p.seo_title || p.title;
  return {
    title,
    description,
    alternates: { canonical: `/p/${p.slug}` },
    openGraph: { title, description, images: p.images.slice(0, 1) },
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
    countryOfOrigin: p.country_of_origin || undefined,
    aggregateRating: p.rating_count ? { "@type": "AggregateRating", ratingValue: p.rating_avg, reviewCount: p.rating_count } : undefined,
    offers: {
      "@type": "Offer",
      priceCurrency: "INR",
      price: (p.price / 100).toFixed(2),
      availability: p.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      seller: { "@type": "Organization", name: p.seller.name },
      hasMerchantReturnPolicy: {
        "@type": "MerchantReturnPolicy",
        applicableCountry: "IN",
        returnPolicyCategory: p.return_window_days > 0 ? "https://schema.org/MerchantReturnFiniteReturnWindow" : "https://schema.org/MerchantReturnNotPermitted",
        merchantReturnDays: p.return_window_days > 0 ? p.return_window_days : undefined,
      },
    },
  };
  const info = [...(p.info ?? [])];
  if (p.bestseller) info.push({ label: "Best sellers rank", value: `#${p.bestseller.rank} in ${p.bestseller.category}` });
  if (p.first_available) info.push({ label: "On sale since", value: fmtDate(p.first_available) });
  const specs = Object.entries(p.specs);

  return (
    <div className="flex flex-col gap-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <nav className="text-sm text-ink-faint" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-peacock">Home</Link>
        {p.breadcrumbs.map((b) => (
          <span key={b.slug}>
            {" › "}
            <Link href={`/c/${b.slug}`} className="hover:text-peacock">{b.name}</Link>
          </span>
        ))}
      </nav>

      <ProductMain p={p} />

      {(p.important?.length ?? 0) > 0 && (
        <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="important-h">
          <h2 id="important-h" className="mb-3 text-xl font-semibold">Important information</h2>
          <div className="grid gap-5 md:grid-cols-2">
            {p.important!.map((x) => (
              <div key={x.title}>
                <h3 className="mb-1 font-semibold">{x.title}</h3>
                <p className="whitespace-pre-line text-ink-soft">{x.text}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {p.tags && p.tags.length > 0 && (
        <p className="mt-4 flex flex-wrap gap-2" aria-label="Tags">
          {p.tags.map((t) => <Link key={t} href={`/search?tag=${encodeURIComponent(t)}`} className="rounded-full border border-line px-3 py-1 text-sm text-ink-soft hover:text-peacock">{t}</Link>)}
        </p>
      )}
      {p.description && (
        <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="desc-h">
          <h2 id="desc-h" className="mb-2 text-xl font-semibold">Product description</h2>
          <p className="max-w-prose whitespace-pre-line text-ink-soft">{p.description}</p>
        </section>
      )}

      {(specs.length > 0 || info.length > 0) && (
        <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="info-h" id="product-information">
          <h2 id="info-h" className="mb-3 text-xl font-semibold">Product information</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            {specs.length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold">Specifications</h3>
                <table className="w-full overflow-hidden rounded-lg text-[14px] ring-1 ring-line">
                  <tbody>
                    {specs.map(([k, v]) => (
                      <tr key={k} className="border-b border-line last:border-0">
                        <th scope="row" className="w-2/5 bg-mist px-3 py-2 text-left align-top font-semibold">{k}</th>
                        <td className="px-3 py-2 text-ink-soft">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {info.length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold">Item details</h3>
                <table className="w-full overflow-hidden rounded-lg text-[14px] ring-1 ring-line">
                  <tbody>
                    {info.map((r) => (
                      <tr key={r.label} className="border-b border-line last:border-0">
                        <th scope="row" className="w-2/5 bg-mist px-3 py-2 text-left align-top font-semibold">{r.label}</th>
                        <td className="whitespace-pre-line px-3 py-2 text-ink-soft">{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <BoughtTogether slug={p.slug} />
      <ProductReviews slug={p.slug} />
      <ProductQuestions slug={p.slug} title={p.title} />
      {(p.bought_together?.length ?? 0) > 0 && <ProductRail title="Bought together" items={p.bought_together ?? []} />}
      {p.similar.length > 0 && <ProductRail title="Customers also viewed" items={p.similar} />}
      <SponsoredRail slug={p.slug} />
      <BrowsingHistory currentId={p.id} />
    </div>
  );
}
