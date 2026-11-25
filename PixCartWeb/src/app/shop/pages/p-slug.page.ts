/* The product page: breadcrumbs, the gallery and buy box, details, reviews, questions and rails.
 * Port of frontend/src/app/(shop)/p/[slug]/page.tsx (+ loading.tsx: the product page skeleton while it loads). */

import { ChangeDetectionStrategy, Component, computed, effect, input, signal, untracked } from "@angular/core";
import { ApiError, api } from "../../core/api";
import { setPageTitle } from "../../core/brand";
import { date as fmtDate } from "../../core/format";
import type { ProductPage } from "../../core/types";
import { ShopNotFound } from "../../shared/chrome/not-found-pages";
import { ProductRail } from "../../shared/product/product";
import { PcLink } from "../../shared/ui/link";
import { ProductPageSkeleton } from "../../shared/ui/skeletons";
import { BoughtTogether } from "../browse/bought-together";
import { BrowsingHistory, ProductMain } from "../browse/buy-box";
import { SponsoredRail } from "../browse/pdp";
import { ProductQuestions } from "../browse/qa";
import { ProductReviews } from "../browse/reviews";

@Component({
  selector: "pc-shop-p-slug-page",
  imports: [PcLink, ShopNotFound, ProductPageSkeleton, ProductMain, ProductRail, BoughtTogether, SponsoredRail, ProductQuestions, ProductReviews, BrowsingHistory],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (state() === "missing") {
      <pc-shop-not-found />
    } @else if (product(); as p) {
      @for (k of [p.id]; track k) {
        <div class="flex flex-col gap-4">
          <nav class="text-sm text-ink-faint" aria-label="Breadcrumb">
            <a pcLink="/" class="hover:text-peacock">Home</a>
            @for (b of p.breadcrumbs; track b.slug) {<span>{{ " › " }}<a [pcLink]="'/c/' + b.slug" class="hover:text-peacock">{{ b.name }}</a></span>}
          </nav>

          <pc-product-main [p]="p" />

          @if ((p.important?.length ?? 0) > 0) {
            <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="important-h">
              <h2 id="important-h" class="mb-3 text-xl font-semibold">Important information</h2>
              <div class="grid gap-5 md:grid-cols-2">
                @for (x of p.important!; track x.title) {
                  <div>
                    <h3 class="mb-1 font-semibold">{{ x.title }}</h3>
                    <p class="whitespace-pre-line text-ink-soft">{{ x.text }}</p>
                  </div>
                }
              </div>
            </section>
          }

          @if (p.description) {
            <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="desc-h">
              <h2 id="desc-h" class="mb-2 text-xl font-semibold">Product description</h2>
              <p class="max-w-prose whitespace-pre-line text-ink-soft">{{ p.description }}</p>
            </section>
          }

          @if (specs().length > 0 || info().length > 0) {
            <section class="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="info-h" id="product-information">
              <h2 id="info-h" class="mb-3 text-xl font-semibold">Product information</h2>
              <div class="grid gap-6 lg:grid-cols-2">
                @if (specs().length > 0) {
                  <div>
                    <h3 class="mb-2 font-semibold">Specifications</h3>
                    <table class="w-full overflow-hidden rounded-lg text-[14px] ring-1 ring-line">
                      <tbody>
                        @for (s of specs(); track s[0]) {
                          <tr class="border-b border-line last:border-0">
                            <th scope="row" class="w-2/5 bg-mist px-3 py-2 text-left align-top font-semibold">{{ s[0] }}</th>
                            <td class="px-3 py-2 text-ink-soft">{{ s[1] }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
                @if (info().length > 0) {
                  <div>
                    <h3 class="mb-2 font-semibold">Item details</h3>
                    <table class="w-full overflow-hidden rounded-lg text-[14px] ring-1 ring-line">
                      <tbody>
                        @for (r of info(); track r.label) {
                          <tr class="border-b border-line last:border-0">
                            <th scope="row" class="w-2/5 bg-mist px-3 py-2 text-left align-top font-semibold">{{ r.label }}</th>
                            <td class="whitespace-pre-line px-3 py-2 text-ink-soft">{{ r.value }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              </div>
            </section>
          }

          <pc-bought-together [slug]="p.slug" />
          <pc-product-reviews [slug]="p.slug" />
          <pc-product-questions [slug]="p.slug" [title]="p.title" />
          @if (p.similar.length > 0) {<pc-product-rail title="Customers also viewed" [items]="p.similar" />}
          <pc-sponsored-rail [slug]="p.slug" />
          <pc-browsing-history [currentId]="p.id" />
        </div>
      }
    } @else {
      <pc-product-page-skeleton />
    }
  `,
})
export class ShopPSlugPage {
  readonly slug = input.required<string>();
  protected readonly product = signal<ProductPage | null>(null);
  protected readonly state = signal<"loading" | "ready" | "missing">("loading");
  protected readonly specs = computed(() => Object.entries(this.product()?.specs ?? {}));
  protected readonly info = computed(() => {
    const p = this.product();
    if (!p) return [];
    const info = [...(p.info ?? [])];
    if (p.bestseller) info.push({ label: "Best sellers rank", value: `#${p.bestseller.rank} in ${p.bestseller.category}` });
    if (p.first_available) info.push({ label: "On sale since", value: fmtDate(p.first_available) });
    return info;
  });
  private ld: HTMLScriptElement | null = null;

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => {
        this.product.set(null);
        this.state.set("loading");
      });
      api<ProductPage>(`/api/catalog/products/${encodeURIComponent(slug)}`)
        .then((p) => {
          if (slug !== this.slug()) return;
          this.product.set(p);
          this.state.set("ready");
          setPageTitle(p.title);
          this.jsonLd(p);
        })
        .catch((e) => {
          if (slug !== this.slug()) return;
          this.state.set("missing");
          if (e instanceof ApiError && e.status === 404) setPageTitle("Product not found");
        });
    });
  }

  ngOnDestroy() {
    this.ld?.remove();
  }

  /** The schema.org Product description search engines read (the reference renders it in the page). */
  private jsonLd(p: ProductPage) {
    const data = {
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
    if (!this.ld) {
      this.ld = document.createElement("script");
      this.ld.type = "application/ld+json";
      document.head.appendChild(this.ld);
    }
    this.ld.textContent = JSON.stringify(data).replace(/</g, "\\u003c");
  }
}
