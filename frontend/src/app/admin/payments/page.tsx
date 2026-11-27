"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

// Admin -> Payments. Same endpoints and wording as the .NET/Angular version (/api/admin/payments/*).
type Gateway = { code: string; name: string; configured: boolean; enabled: boolean; mode: string; currencies: string[]; client_mode: string; circuit: string; attempts: number; ok: number; success_rate: number | null; avg_ms: number | null; p95_ms: number | null; last_error: string; last_error_at: string | null };
type Routing = { order: string[]; failover: boolean; strategy: string; timeout_seconds: number; circuit_failures: number; circuit_cooldown_seconds: number; window_minutes: number; min_samples: number };
const NUMBERS: [keyof Routing, string][] = [["timeout_seconds", "Gateway timeout (seconds)"], ["circuit_failures", "Failures before a gateway is paused"], ["circuit_cooldown_seconds", "Pause length (seconds)"], ["window_minutes", "Look-back window (minutes)"], ["min_samples", "Attempts needed to judge a gateway"]];

export default function AdminPaymentsPage() {
  const toast = useToast();
  const [gateways, setGateways] = useState<Gateway[] | null>(null);
  const [r, setR] = useState<Routing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ gateways: Gateway[]; routing: Routing }>("/api/admin/payments/gateways").then((x) => { setGateways(x.gateways); setR(x.routing); }).catch(quietly);
  }, []);
  const move = (code: string, d: number) => setR((cur) => {
    if (!cur) return cur;
    const o = [...cur.order]; const i = o.indexOf(code); const j = i + d;
    if (i < 0 || j < 0 || j >= o.length) return cur;
    [o[i], o[j]] = [o[j], o[i]];
    return { ...cur, order: o };
  });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!r) return;
    setError(null);
    try {
      const x = await api<{ routing: Routing; gateways: Gateway[] }>("/api/admin/payments/routing", { method: "PUT", body: r });
      setR(x.routing); setGateways(x.gateways); toast("Payment routing saved");
    } catch (x) { setError(x instanceof ApiError ? x.message : "Could not save"); }
  }
  async function test(code: string) {
    setTesting(code);
    try {
      const x = await api<{ ok: boolean; ms: number; message: string }>(`/api/admin/payments/gateways/${code}/test`, { method: "POST", body: {} });
      setResults((cur) => ({ ...cur, [code]: (x.ok ? "Connected" : "Failed") + ": " + x.message + (x.ms ? ` (${x.ms} ms)` : "") }));
    } catch (x) { setResults((cur) => ({ ...cur, [code]: x instanceof ApiError ? x.message : "Could not test" })); } finally { setTesting(null); }
  }
  if (!gateways || !r) return <PageLoader />;
  const byCode = new Map(gateways.map((g) => [g.code, g]));
  return (
    <div>
      <PageHeader title="Payments" sub="Order the gateways, set failover and watch the last 24 hours. Enter keys on Integrations first." />
      <form onSubmit={save} className="flex max-w-4xl flex-col gap-4">
        <ErrorNote message={error} />
        <section className="rounded-xl bg-white p-5" data-testid="gateway-order">
          <h2 className="text-lg font-semibold">Gateway order</h2>
          <p className="mb-3 text-sm text-ink-soft">Checkout tries them top to bottom. A gateway that is off or has no keys is skipped.</p>
          {r.order.map((code, i) => {
            const g = byCode.get(code);
            if (!g) return null;
            return (
              <div key={code} className="flex flex-wrap items-center gap-3 border-b border-line/50 py-3" data-testid={"gateway-" + code}>
                <span className="w-6 text-ink-soft">{i + 1}</span>
                <div className="min-w-40 flex-1">
                  <div className="font-semibold">{g.name} {g.mode && <span className="text-xs text-ink-soft">({g.mode})</span>}</div>
                  <div className="text-xs text-ink-soft">{g.enabled ? "On" : g.configured ? "Off" : "No keys"} · {g.client_mode} · {g.currencies.join(", ")} · {g.circuit === "open" ? "paused after failures" : "healthy"}</div>
                  <div className="text-xs text-ink-soft">{g.attempts ? `${g.ok}/${g.attempts} ok${g.success_rate !== null ? ` (${Math.round(g.success_rate * 100)}%)` : ""}, avg ${g.avg_ms} ms, p95 ${g.p95_ms} ms` : "No attempts in the last 24 hours"}</div>
                  {g.last_error && <div className="text-xs text-red-700">Last error: {g.last_error}</div>}
                  {results[code] && <div className="text-xs">{results[code]}</div>}
                </div>
                <Button type="button" variant="ghost" onClick={() => move(code, -1)} disabled={i === 0} aria-label={"Move " + g.name + " up"}>Up</Button>
                <Button type="button" variant="ghost" onClick={() => move(code, 1)} disabled={i === r.order.length - 1} aria-label={"Move " + g.name + " down"}>Down</Button>
                <Button type="button" variant="ghost" onClick={() => test(code)} disabled={testing === code}>{testing === code ? "Testing…" : "Test connection"}</Button>
              </div>
            );
          })}
        </section>
        <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <label className="flex items-center gap-3 rounded-lg border border-line p-3 sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={r.failover} onChange={(e) => setR({ ...r, failover: e.target.checked })} /> <span className="font-semibold">Try the next gateway when one fails</span></label>
          <label className="flex flex-col gap-1 text-sm"><span className="font-semibold">Pick by</span>
            <select className="rounded-lg border border-line px-3 py-2" value={r.strategy} onChange={(e) => setR({ ...r, strategy: e.target.value })}><option value="priority">Order above</option><option value="success_rate">Best recent success rate</option></select></label>
          {NUMBERS.map(([k, text]) => (
            <label key={k} className="flex flex-col gap-1 text-sm"><span className="font-semibold">{text}</span>
              <input type="number" className="rounded-lg border border-line px-3 py-2" value={r[k] as number} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} /></label>
          ))}
        </section>
        <div><Button type="submit">Save</Button></div>
      </form>
    </div>
  );
}
