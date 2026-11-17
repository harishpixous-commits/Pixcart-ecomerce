import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { date } from "@/lib/format";
import { serverGet } from "@/lib/server-api";

type Page = { slug: string; title: string; body: string; meta_description: string; updated_at: string | null };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const p = await serverGet<Page>(`/api/pages/${encodeURIComponent(slug)}`, 0).catch(() => null);
  return p ? { title: p.title, description: p.meta_description || undefined } : { title: "Page not found" };
}

export default async function CmsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await serverGet<Page>(`/api/pages/${encodeURIComponent(slug)}`, 0);
  if (!p) notFound();
  return (
    <article className="mx-auto max-w-3xl rounded-xl bg-white p-6 sm:p-10">
      <h1 className="mb-1 text-3xl font-semibold">{p.title}</h1>
      {p.updated_at && <p className="mb-6 text-sm text-ink-faint">Last updated {date(p.updated_at)}</p>}
      <Markdown source={p.body} />
    </article>
  );
}
