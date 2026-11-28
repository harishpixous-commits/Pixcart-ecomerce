"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date } from "@/lib/format";

// Admin -> AI agents. Same endpoints and wording as the .NET/Angular version (/api/admin/agents/*).
// Agents write proposals from real data. Nothing runs until a person presses Approve.
type AgentInfo = { key: string; label: string; job: string; not_wired: string; enabled: boolean; pending: number };
type Overview = { settings: Record<string, boolean | number>; agents: AgentInfo[] };
type Proposal = { id: string; agent: string; kind: string; summary: string; details: string[][]; status: string; result: { note?: string; error?: string }; created_at: string };

const NUMBERS: Record<string, string> = {
  expire_hours: "Proposals expire after (hours)", max_per_run: "Most new proposals per run",
  delivery_nudge_hours: "Remind seller after (hours unshipped)", delivery_tracking_hours: "Ask for tracking after (hours since shipped)",
  delivery_cancel_hours: "Propose cancel and refund after (hours unshipped)", delivery_max_age_days: "Ignore packages older than (days)",
  reorder_cover_days: "Restock when stock lasts less than (days)", reorder_window_days: "Sales window (days)", reorder_min_sold: "Only items that sold at least (units)",
  marketing_window_days: "Sales window (days)", marketing_max_sold: "Slow if it sold at most (units)", marketing_min_items: "Only categories with at least (items in stock)",
  marketing_discount_percent: "Discount (%)", marketing_valid_days: "Coupon valid for (days)",
  support_wait_hours: "Reply when a ticket waited (hours)", support_max_age_days: "Ignore tickets older than (days)",
  assistant_window_days: "Digest covers the last (days)", assistant_low_stock: "Count items with at most (units left)", assistant_ticket_hours: "Count tickets unanswered for (hours)",
  orderupdate_late_hours: "Tell customer after (hours past the promised date)", orderupdate_max_age_days: "Ignore packages more than (days) past due",
};

export default function AgentsPage() {
  const toast = useToast();
  const [ov, setOv] = useState<Overview | null>(null);
  const [items, setItems] = useState<Proposal[]>([]);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Overview>("/api/admin/agents").then(setOv).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load"));
    api<{ items: Proposal[] }>(`/api/admin/agents/proposals?status=${status}`).then((x) => setItems(x.items)).catch(quietly);
  }, [status]);
  useEffect(load, [load]);

  async function save(patch: Record<string, boolean | number>) {
    try { await api("/api/admin/agents/settings", { method: "PUT", body: patch }); load(); } catch (e) { toast(e instanceof ApiError ? e.message : "Could not save"); }
  }
  async function decide(p: Proposal, d: "approve" | "reject") {
    try { await api(`/api/admin/agents/proposals/${p.id}/${d}`, { method: "POST", body: {} }); toast(d === "approve" ? "Done" : "Rejected"); } catch (e) { toast(e instanceof ApiError ? e.message : "Could not do this"); }
    load();
  }
  async function runNow() {
    const r = await api<{ new: Record<string, number> }>("/api/admin/agents/run", { method: "POST", body: {} });
    toast(`${Object.values(r.new).reduce((a, b) => a + b, 0)} new proposal(s)`); load();
  }

  if (!ov) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div data-testid="agents-page">
      <PageHeader title="AI agents" sub="Agents look at your real orders and write proposals. Nothing happens until you press Approve. They run on plain rules, with no paid AI service." actions={<Button onClick={runNow}>Run now</Button>} />
      <label className="mb-4 flex items-center gap-3 rounded-lg bg-white p-3"><input type="checkbox" checked={!!ov.settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> <span className="font-semibold">Agents switched on (master switch)</span></label>
      <div className="grid gap-3 md:grid-cols-2">
        {ov.agents.map((a) => (
          <section key={a.key} className="rounded-xl bg-white p-4" data-testid={`agent-${a.key}`}>
            <label className="flex items-center gap-3"><input type="checkbox" checked={!!ov.settings[`${a.key}_enabled`]} onChange={(e) => save({ [`${a.key}_enabled`]: e.target.checked })} /> <span className="font-semibold">{a.label}</span> <span className="text-sm text-ink-soft">{a.pending} waiting</span></label>
            <p className="mt-2 text-sm">{a.job}</p>
            <p className="mt-1 text-sm text-ink-soft">Not done yet: {a.not_wired}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {Object.keys(NUMBERS).filter((k) => k.startsWith(a.key + "_")).map((k) => (
                <label key={k} className="flex flex-col gap-1 text-sm"><span>{NUMBERS[k]}</span>
                  <input className="rounded-lg border border-line px-3 py-2" defaultValue={String(ov.settings[k])} onBlur={(e) => { const n = Number(e.target.value); if (n !== ov.settings[k]) save({ [k]: n }); }} /></label>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Proposals</h2>
        {["pending", "done", "rejected", "expired", "failed"].map((s) => <button key={s} type="button" className={`rounded-full px-3 py-1 text-sm ${status === s ? "bg-peacock text-white" : "bg-white"}`} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      <div className="mt-3 flex flex-col gap-3" data-testid="agent-proposals">
        {items.length === 0 && <p className="rounded-lg bg-white p-4 text-sm">Nothing here.</p>}
        {items.map((p) => (
          <div key={p.id} className="rounded-xl bg-white p-4">
            <p className="font-semibold">{p.summary}</p>
            <p className="text-sm text-ink-soft">{p.details.map(([k, v]) => `${k}: ${v}`).join(" · ")} · {date(p.created_at)}</p>
            {(p.result?.note || p.result?.error) && <p className="mt-1 text-sm">{p.result.note || p.result.error}</p>}
            {p.status === "pending" && <div className="mt-3 flex gap-2"><Button onClick={() => decide(p, "approve")}>Approve</Button><Button variant="secondary" onClick={() => decide(p, "reject")}>Reject</Button></div>}
          </div>
        ))}
      </div>
    </div>
  );
}
