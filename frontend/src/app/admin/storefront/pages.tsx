"use client";

import { ExternalLink, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button, ErrorNote, Field, PageLoader, Pill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date } from "@/lib/format";

type P = { slug: string; title: string; body: string; meta_description: string; is_published: boolean; saved: boolean; updated_at: string | null };

export function PagesEditor() {
  const toast = useToast();
  const [pages, setPages] = useState<P[] | null>(null);
  const [cur, setCur] = useState<(P & { original: string | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<P[]>("/api/admin/storefront/pages").then((p) => { setPages(p); return p; }), []);
  useEffect(() => {
    load().then((p) => p[0] && setCur({ ...p[0], original: p[0].slug })).catch(quietly);
  }, [load]);

  async function save() {
    if (!cur) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ slug: string }>(`/api/admin/storefront/pages/${cur.original ?? cur.slug}`, { method: "PUT", body: { slug: cur.slug, title: cur.title, body: cur.body, meta_description: cur.meta_description, is_published: cur.is_published } });
      toast("Page saved");
      const list = await load();
      const p = list.find((x) => x.slug === r.slug);
      if (p) setCur({ ...p, original: p.slug });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!pages) return <PageLoader />;
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <aside className="self-start rounded-xl bg-white p-2">
        <ul className="flex flex-col">
          {pages.map((p) => (
            <li key={p.slug}>
              <button onClick={() => { setError(null); setCur({ ...p, original: p.slug }); }} className={`w-full rounded-lg px-3 py-2 text-left ${cur?.original === p.slug ? "bg-peacock-light font-semibold text-peacock" : "hover:bg-mist"}`}>
                {p.title}
                <span className="block text-xs font-normal text-ink-faint">/pages/{p.slug}{!p.saved ? ", default text" : !p.is_published ? ", hidden" : ""}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setCur({ slug: "new-page", title: "New page", body: "", meta_description: "", is_published: false, saved: false, updated_at: null, original: null })}><Plus className="h-4 w-4" /> New page</Button>
      </aside>
      {cur && (
        <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{cur.original ? "Edit page" : "New page"}</h2>
            {!cur.saved && cur.original && <Pill tone="blue">Showing default text until you save</Pill>}
            {cur.updated_at && <span className="text-sm text-ink-faint">Saved {date(cur.updated_at)}</span>}
            {cur.original && <a href={`/pages/${cur.original}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-peacock">Open page <ExternalLink className="h-4 w-4" /></a>}
          </div>
          <ErrorNote message={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Title" value={cur.title} maxLength={160} onChange={(e) => setCur({ ...cur, title: e.target.value })} />
            <TextField label="Address" value={cur.slug} maxLength={80} onChange={(e) => setCur({ ...cur, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} hint={`yourshop.in/pages/${cur.slug}`} />
            <TextField className="sm:col-span-2" label="Search engine description" value={cur.meta_description} maxLength={300} onChange={(e) => setCur({ ...cur, meta_description: e.target.value })} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Content">
              <Textarea rows={20} value={cur.body} onChange={(e) => setCur({ ...cur, body: e.target.value })} className="font-mono text-sm" />
            </Field>
            <div>
              <p className="mb-1 font-medium">Preview</p>
              <div className="max-h-[520px] overflow-auto rounded-lg border border-line p-4"><h1 className="mb-3 font-display text-2xl font-bold">{cur.title}</h1><Markdown source={cur.body} /></div>
            </div>
          </div>
          <p className="text-xs text-ink-faint">Formatting: ## Heading, ### Smaller heading, **bold**, *italic*, - list item, 1. numbered item, [link text](/pages/about), &gt; quote</p>
          <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={cur.is_published} onChange={(e) => setCur({ ...cur, is_published: e.target.checked })} /> Published</label>
          <div className="flex gap-2">
            <Button onClick={save} loading={busy}>Save page</Button>
            {cur.saved && cur.original && (
              <Button variant="ghost" onClick={async () => {
                if (!window.confirm("Delete this page? Built-in pages go back to their default text.")) return;
                await api(`/api/admin/storefront/pages/${cur.original}`, { method: "DELETE" });
                const list = await load();
                setCur(list[0] ? { ...list[0], original: list[0].slug } : null);
              }}>Delete page</Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
