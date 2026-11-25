/* A content page (terms, privacy, policies) edited in Admin → Storefront → Pages. Port of frontend/src/app/(shop)/pages/[slug]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, input, signal, untracked } from "@angular/core";
import { ApiError, api } from "../../core/api";
import { setPageTitle } from "../../core/brand";
import { date } from "../../core/format";
import { Markdown } from "../../shared/chrome/markdown";
import { ShopNotFound } from "../../shared/chrome/not-found-pages";
import { ShopRouteSkeleton } from "../../shared/ui/skeletons";

type Page = { slug: string; title: string; body: string; meta_description: string; updated_at: string | null };

@Component({
  selector: "pc-shop-pages-slug-page",
  imports: [Markdown, ShopNotFound, ShopRouteSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (state() === "missing") {
      <pc-shop-not-found />
    } @else if (page(); as p) {
      <article class="mx-auto max-w-3xl rounded-xl bg-white p-6 sm:p-10">
        <h1 class="mb-1 text-3xl font-semibold">{{ p.title }}</h1>
        @if (p.updated_at) {<p class="mb-6 text-sm text-ink-faint">Last updated {{ fmtDate(p.updated_at) }}</p>}
        <pc-markdown [source]="p.body" />
      </article>
    } @else {
      <pc-shop-route-skeleton />
    }
  `,
})
export class ShopPagesSlugPage {
  readonly slug = input.required<string>();
  protected readonly page = signal<Page | null>(null);
  protected readonly state = signal<"loading" | "ready" | "missing">("loading");
  protected readonly fmtDate = date;

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => {
        this.page.set(null);
        this.state.set("loading");
      });
      api<Page>(`/api/pages/${encodeURIComponent(slug)}`)
        .then((p) => {
          if (slug !== this.slug()) return;
          this.page.set(p);
          this.state.set("ready");
          setPageTitle(p.title);
        })
        .catch((e) => {
          if (slug !== this.slug()) return;
          this.state.set("missing");
          if (e instanceof ApiError && e.status === 404) setPageTitle("Page not found");
        });
    });
  }
}
