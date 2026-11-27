"use client";

import { BellPlus, BellOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";

type Saved = { id: string; query: string; max_price_paise: number | null; last_notified_at: string | null };
type SavedList = { enabled: boolean; max_per_user: number; items: Saved[] };

function useSaved() {
  const { user, ready } = useSession();
  const [data, setData] = useState<SavedList | null>(null);
  const load = useCallback(() => api<SavedList>("/api/saved-searches").then(setData).catch(() => setData(null)), []);
  useEffect(() => { if (ready && user) load(); }, [ready, user, load]);
  return { user, data, load };
}

/** "Follow this search": shown on a search result page when staff switched saved searches on and the shopper is signed in. */
export function SaveSearchButton({ query, maxPaise }: { query: string; maxPaise: number | null }) {
  const { user, data, load } = useSaved();
  const toast = useToast();
  if (!user || !data?.enabled || !query.trim()) return null;
  const has = data.items.some((s) => s.query.toLowerCase() === query.trim().toLowerCase().replace(/\s+/g, " ") && s.max_price_paise === maxPaise);
  async function follow() {
    try {
      await api("/api/saved-searches", { method: "POST", body: { query, max_price_paise: maxPaise } });
      toast("We will tell you when new matches arrive");
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save this search", "error");
    }
  }
  return (
    <button type="button" onClick={follow} disabled={has} data-testid="save-search"
      className="mt-1 inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm font-semibold text-peacock disabled:text-ink-faint">
      <BellPlus className="h-4 w-4" /> {has ? "Following this search" : "Tell me about new matches"}
    </button>
  );
}

/** The shopper's followed searches, on the alerts page. Hidden while the feature is off. */
export function SavedSearchesSection() {
  const { data, load } = useSaved();
  const toast = useToast();
  if (!data?.enabled) return null;
  async function remove(id: string) {
    try {
      await api(`/api/saved-searches/${id}`, { method: "DELETE" });
      load();
      toast("Search removed");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not remove", "error");
    }
  }
  return (
    <section className="rounded-xl bg-white" aria-labelledby="saved-h">
      <h2 id="saved-h" className="border-b border-line px-4 py-3 text-lg font-semibold">Followed searches</h2>
      {data.items.length === 0 ? (
        <p className="px-4 py-6 text-ink-soft">None yet. On a search page, choose <span className="font-semibold">Tell me about new matches</span>.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="saved-searches">
          {data.items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link href={`/search?q=${encodeURIComponent(s.query)}${s.max_price_paise ? `&max_price=${s.max_price_paise}` : ""}`} className="font-medium hover:text-peacock">{s.query}</Link>
                {s.max_price_paise !== null && <p className="text-sm text-ink-faint">Up to {rupees(s.max_price_paise)}</p>}
              </div>
              <button type="button" onClick={() => remove(s.id)} className="flex items-center gap-1 text-sm text-ink-soft hover:text-vermilion"><BellOff className="h-4 w-4" /> Remove</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
