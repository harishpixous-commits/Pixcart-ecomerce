"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { MediaGrid } from "@/components/media-picker";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import type { Site } from "@/lib/types";
import { BrandEditor, NavEditor } from "./brand";
import { BusinessEditor } from "./business";
import { PagesEditor } from "./pages";
import { SectionsEditor } from "./sections";

const TABS = [
  { value: "home", label: "Home page" },
  { value: "brand", label: "Brand and colours" },
  { value: "nav", label: "Menus and footer" },
  { value: "business", label: "Business, contact and social" },
  { value: "pages", label: "Pages" },
  { value: "media", label: "Media library" },
];

function Storefront() {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const tab = sp.get("tab") ?? "home";
  const [site, setSite] = useState<Site | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Site>("/api/admin/storefront/site").then((s) => { setSite(s); setSaved(JSON.stringify(s)); }).catch(quietly);
  }, []);
  const dirty = site !== null && JSON.stringify(site) !== saved;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function saveSite() {
    if (!site) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api<Site>("/api/admin/storefront/site", { method: "PUT", body: site });
      setSite(s);
      setSaved(JSON.stringify(s));
      toast("Saved. The shop shows the change now.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const siteTab = tab === "brand" || tab === "nav" || tab === "business";
  return (
    <div>
      <PageHeader
        title="Storefront"
        sub="Everything shoppers see: the home page, brand, colours, menus and information pages."
        actions={siteTab && site ? (
          <>
            {dirty && <span className="self-center text-sm text-ink-soft">Unsaved changes</span>}
            <Button variant="ghost" disabled={!dirty} onClick={() => setSite(JSON.parse(saved))}>Discard</Button>
            <Button onClick={saveSite} loading={busy} disabled={!dirty}>Save changes</Button>
          </>
        ) : undefined}
      />
      <Tabs value={tab} onChange={(v) => router.replace(`/admin/storefront?tab=${v}`)} items={TABS} />
      <ErrorNote message={error} />
      {tab === "home" && <SectionsEditor />}
      {siteTab && (!site ? <PageLoader /> : tab === "brand" ? <BrandEditor site={site} set={setSite} /> : tab === "business" ? <BusinessEditor site={site} set={setSite} /> : <NavEditor site={site} set={setSite} />)}
      {tab === "pages" && <PagesEditor />}
      {tab === "media" && <div className="rounded-xl bg-white p-5"><MediaGrid /></div>}
    </div>
  );
}

export default function StorefrontPage() {
  return <Suspense fallback={<PageLoader />}><Storefront /></Suspense>;
}
