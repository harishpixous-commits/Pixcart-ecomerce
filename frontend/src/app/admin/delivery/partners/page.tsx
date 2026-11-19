"use client";

import { ChevronRight, Search, UserPlus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { KycPill, OnlineDot, PartnerAvatar, Stars } from "@/components/delivery/admin";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Pagination, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly, quietly } from "@/lib/api";
import type { Partner } from "@/lib/delivery-types";
import { date } from "@/lib/format";

type Data = { items: Partner[]; total: number; page: number; page_size: number; counts: Record<string, number> };
type Zone = { id: string; name: string; city: string };

function PartnersPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [zone, setZone] = useState(sp.get("zone") ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    track(api<Data>("/api/admin/delivery/partners", { query: { status: status || undefined, zone_id: zone || undefined, q: query || undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load partners"));
  }, [status, zone, query, page, track]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<Zone[]>("/api/admin/delivery/zones").then(setZones).catch(quietly); }, []);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const c = d?.counts ?? {};
  const all = ["draft", "submitted", "approved", "rejected"].reduce((n, k) => n + (c[k] ?? 0), 0);

  return (
    <div>
      <PageHeader title="Delivery partners" sub="Review registrations, approve partners for a zone, and switch accounts on or off."
        actions={<Button onClick={() => setAdding(true)}><UserPlus className="h-4 w-4" /> Add partner</Button>} />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[
        { value: "submitted", label: "Waiting for review", count: c.submitted ?? 0 },
        { value: "approved", label: "Approved", count: c.approved ?? 0 },
        { value: "rejected", label: "Needs changes", count: c.rejected ?? 0 },
        { value: "draft", label: "Not submitted", count: c.draft ?? 0 },
        { value: "inactive", label: "Switched off", count: c.inactive ?? 0 },
        { value: "", label: "All", count: all },
      ]} />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, mobile or vehicle number" aria-label="Search partners" className="pl-9" />
        </div>
        <Select value={zone} onChange={(e) => { setZone(e.target.value); setPage(1); }} aria-label="Zone" className="w-auto min-w-[200px]">
          <option value="">All zones</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.city})</option>)}
        </Select>
      </div>
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
        <EmptyState title={status === "submitted" ? "No one is waiting for review" : "No delivery partners here"}
          body={status === "submitted" ? "New registrations from the partner app show up here." : "Partners register in the partner app (/delivery/join), or add one with their mobile number."} />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="partner-list">
          {d.items.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => router.push(`/admin/delivery/partners/${p.id}`)}
                className="flex w-full items-center gap-3 rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30 sm:p-4">
                <PartnerAvatar p={p} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{p.name}</span>
                    <KycPill status={p.kyc_status} active={p.is_active} />
                    {p.kyc_status === "approved" && p.is_active && <OnlineDot online={p.is_online} />}
                  </span>
                  <span className="block text-sm text-ink-soft">{p.phone} · {p.vehicle_label}{p.vehicle_no ? ` ${p.vehicle_no}` : ""} · {p.zone ? `${p.zone.name}, ${p.zone.city}` : p.city || "No zone"}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                    <Stars value={p.rating_avg} count={p.rating_count} />
                    {p.created_at && <span>Joined {date(p.created_at)}</span>}
                    {p.kyc_status !== "approved" && <span>{p.checklist.filter((i) => i.done).length}/{p.checklist.length} details added</span>}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {d && <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a delivery partner">
        <AddPartner zones={zones} onDone={(p) => { setAdding(false); router.push(`/admin/delivery/partners/${p.id}`); }} />
      </Modal>
    </div>
  );
}

function AddPartner({ zones, onDone }: { zones: Zone[]; onDone: (p: Partner) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ phone: "", name: "", city: "", zone_id: "", vehicle_type: "bike", vehicle_no: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Partner>("/api/admin/delivery/partners", { method: "POST", body: {
        phone: f.phone, name: f.name, city: f.city || undefined, zone_id: f.zone_id || undefined, vehicle_type: f.vehicle_type,
        vehicle_no: f.vehicle_type === "cycle" ? "" : f.vehicle_no || undefined,
      } });
      toast("Partner added. They sign in with this mobile number to add documents.");
      onDone(p);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not add the partner");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <ErrorNote message={error} />
      <p className="text-sm text-ink-soft">For partners you hire in person. They sign in to the partner app with this number to upload documents, or you upload them from their page.</p>
      <TextField label="Mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required placeholder="98765 43210" />
      <TextField label="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <Field label="Zone">
          <Select value={f.zone_id} onChange={(e) => setF({ ...f, zone_id: e.target.value })}>
            <option value="">Choose later</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.city})</option>)}
          </Select>
        </Field>
        <Field label="Vehicle">
          <Select value={f.vehicle_type} onChange={(e) => setF({ ...f, vehicle_type: e.target.value })}>
            <option value="bike">Motorbike</option><option value="scooter">Scooter</option><option value="ev">Electric bike or scooter</option>
            <option value="cycle">Bicycle</option><option value="auto">Auto</option><option value="van">Van</option>
          </Select>
        </Field>
        {f.vehicle_type !== "cycle" && <TextField label="Vehicle number" value={f.vehicle_no} onChange={(e) => setF({ ...f, vehicle_no: e.target.value.toUpperCase() })} placeholder="TN 38 AB 1234" />}
      </div>
      <Button type="submit" loading={busy} className="self-start">Add partner</Button>
    </form>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><PartnersPage /></Suspense>;
}
