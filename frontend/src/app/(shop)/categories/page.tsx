import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";
import { serverGet } from "@/lib/server-api";
import type { CategoryNode } from "@/lib/types";

export const metadata = { title: "All categories" };

export default async function CategoriesPage() {
  const cats = (await serverGet<CategoryNode[]>("/api/catalog/categories").catch(() => null)) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <h1 className="px-1 text-2xl font-semibold">All categories</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cats.map((c) => (
          <section key={c.slug} className="rounded-xl bg-white p-4">
            <Link href={`/c/${c.slug}`} className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-peacock-light text-peacock">
                <CategoryIcon slug={c.slug} className="h-6 w-6" />
              </span>
              <span className="font-display text-lg font-semibold">{c.name}</span>
              <span className="ml-auto text-sm text-ink-faint">{c.product_count}</span>
            </Link>
            {c.children.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {c.children.map((s) => (
                  <li key={s.slug}>
                    <Link href={`/c/${s.slug}`} className="inline-block rounded-full bg-mist px-3 py-1 text-sm hover:bg-peacock-light hover:text-peacock">
                      {s.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
