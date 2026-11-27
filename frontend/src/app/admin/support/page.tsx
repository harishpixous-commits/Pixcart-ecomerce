"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, Pill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { ExportButton } from "@/components/export-button";

type T = { id: string; number: string; subject: string; category_label: string; status: string; priority: string; is_grievance: boolean; customer: string; created_at: string; ack_due_at: string; ack_overdue: boolean; resolve_overdue: boolean; acknowledged_at: string | null };

const TICKET_STATUS: Record<string, string> = { open: "Open", awaiting_customer: "Waiting for customer", resolved: "Resolved", closed: "Closed" };

type Csat = { rated: number; unrated_closed: number; average: number | null; spread: Record<string, number>; recent: { id: string; number: string; subject: string; rating: number; comment: string }[] };

function Satisfaction() {
  const [c, setC] = useState<Csat | null>(null);
  useEffect(() => { api<Csat>("/api/admin/tickets/satisfaction").then(setC).catch(quietly); }, []);
  if (!c) return null;
  return (
    <section className="mb-4 rounded-xl bg-white p-4 text-sm" data-testid="csat-summary">
      <h2 className="font-semibold">Customer satisfaction</h2>
      {c.rated === 0 ? <p className="text-ink-soft">No ratings yet. {c.unrated_closed} resolved requests are waiting for one.</p> : (
        <>
          <p className="mt-1">Average <span className="text-lg font-semibold">{c.average}/5</span> from {c.rated} ratings. {c.unrated_closed} resolved requests are not rated yet.</p>
          <p className="mt-1 text-ink-soft">{[5, 4, 3, 2, 1].map((n) => `${n}: ${c.spread[String(n)] ?? 0}`).join("   ")}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {c.recent.filter((r) => r.comment).slice(0, 3).map((r) => <li key={r.id}><Link href={`/admin/support/${r.id}`} className="font-semibold text-peacock">{r.number}</Link> {r.rating}/5, "{r.comment}"</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function Desk() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "open";
  const overdue = sp.get("overdue") === "1";
  const grievance = sp.get("grievance") === "1";
  const [d, setD] = useState<{ items: T[]; status_counts: Record<string, number>; total: number; page: number; page_size: number } | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => api<typeof d>("/api/admin/tickets", { query: { status: status === "all" ? "" : status, overdue: overdue || undefined, grievance: grievance || undefined, q, page } }).then(setD).catch(quietly), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, overdue, grievance, q, page]);
  const go = (q: Record<string, string>) => router.replace(`/admin/support?${new URLSearchParams({ status, ...(overdue ? { overdue: "1" } : {}), ...(grievance ? { grievance: "1" } : {}), ...q })}`);
  const c = d?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Support desk" sub="E-commerce rules: acknowledge every complaint within 48 hours and resolve it within one month." actions={<ExportButton scope="admin" name="tickets" status={status === "all" ? undefined : status} />} />
      <Satisfaction />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onChange={(v) => go({ status: v })} items={[...Object.entries(TICKET_STATUS).map(([v, l]) => ({ value: v, label: l, count: c[v] ?? 0 })), { value: "all", label: "All" }]} />
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={overdue} onChange={(e) => router.replace(`/admin/support?status=${status}${e.target.checked ? "&overdue=1" : ""}${grievance ? "&grievance=1" : ""}`)} /> Not acknowledged in time</label>
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={grievance} onChange={(e) => router.replace(`/admin/support?status=${status}${overdue ? "&overdue=1" : ""}${e.target.checked ? "&grievance=1" : ""}`)} /> Grievances only</label>
      </div>
      <Input placeholder="Ticket number, subject, customer name or mobile" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search tickets" />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="Nothing waiting" body="New tickets appear here." /> : (
        <>
        <Table head={["Ticket", "Customer", "Topic", "Opened", "Reply due", "Status"]}>
          {d.items.map((t) => (
            <tr key={t.id} className="hover:bg-mist/60">
              <td className="px-4 py-2.5">
                <Link href={`/admin/support/${t.id}`} className="font-semibold text-peacock">{t.number}</Link>
                <p className="line-clamp-1 text-sm">{t.subject}</p>
              </td>
              <td className="px-4 py-2.5 text-sm">{t.customer}</td>
              <td className="px-4 py-2.5 text-sm">{t.category_label}{t.is_grievance && <> <Pill tone="red">Grievance</Pill></>}</td>
              <td className="px-4 py-2.5 text-sm">{dateTime(t.created_at)}</td>
              <td className="px-4 py-2.5 text-sm">{t.acknowledged_at ? "Replied" : <span className={t.ack_overdue ? "font-semibold text-vermilion" : ""}>{dateTime(t.ack_due_at)}</span>}</td>
              <td className="px-4 py-2.5">
                <Pill tone={t.status === "open" ? "blue" : t.status === "resolved" || t.status === "closed" ? "green" : "gray"}>{TICKET_STATUS[t.status]}</Pill>
                {t.priority !== "normal" && <p className="text-xs text-ink-faint">{t.priority}</p>}
              </td>
            </tr>
          ))}
        </Table>
        <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export default function SupportDesk() {
  return <Suspense fallback={<PageLoader />}><Desk /></Suspense>;
}
