"use client";

import clsx from "clsx";
import { MapPinned, Pencil, Plus, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Modal, PageLoader, Pill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

type Zone = { id: string; name: string; city: string; pincodes: string[]; is_active: boolean; center_lat: number | null; center_lng: number | null; partners: number; approved: number; online: number };

export default function ZonesPage() {
  const toast = useToast();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [edit, setEdit] = useState<Zone | "new" | null>(null);
  const load = useCallback(() => api<Zone[]>("/api/admin/delivery/zones").then(setZones).catch(quietly), []);
  useEffect(() => { load(); }, [load]);

  async function remove(z: Zone) {
    if (!window.confirm(`Delete the zone ${z.name}?`)) return;
    try {
      await api(`/api/admin/delivery/zones/${z.id}`, { method: "DELETE" });
      toast("Zone deleted");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not delete", "error");
    }
  }

  const cities = zones ? Array.from(new Set(zones.map((z) => z.city))) : [];
  return (
    <div>
      <PageHeader title="Delivery zones" sub="The PIN codes your delivery partners cover. Packages from a store in a zone to a customer in a zone of the same city go to your partners."
        actions={<Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" /> New zone</Button>} />
      {!zones ? <PageLoader /> : zones.length === 0 ? (
        <EmptyState title="No zones yet" body="Create a zone with the PIN codes your partners can reach, for example one zone per part of a city." action={<Button onClick={() => setEdit("new")}>Create the first zone</Button>} />
      ) : (
        <div className="flex flex-col gap-6">
          {cities.map((city) => (
            <section key={city}>
              <h2 className="mb-2 text-lg font-semibold">{city}</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {zones.filter((z) => z.city === city).map((z) => (
                  <article key={z.id} className={clsx("flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5", !z.is_active && "opacity-70")} data-testid="zone-card">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock"><MapPinned className="h-5 w-5" aria-hidden /></span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold">{z.name}</p>
                        <p className="text-sm text-ink-soft">{z.pincodes.length} PIN code{z.pincodes.length === 1 ? "" : "s"}</p>
                      </div>
                      {!z.is_active && <Pill tone="gray">Off</Pill>}
                    </div>
                    <p className="line-clamp-2 font-mono text-xs text-ink-soft">{z.pincodes.join(", ")}</p>
                    <div className="grid grid-cols-3 gap-2 rounded-xl bg-mist p-2 text-center">
                      <div><p className="text-xs text-ink-faint">Partners</p><p className="font-bold">{z.partners}</p></div>
                      <div><p className="text-xs text-ink-faint">Approved</p><p className="font-bold">{z.approved}</p></div>
                      <div><p className="text-xs text-ink-faint">Online</p><p className={clsx("font-bold", z.online ? "text-leaf" : "")}>{z.online}</p></div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setEdit(z)}><Pencil className="h-4 w-4" /> Edit</Button>
                      <Link href={`/admin/delivery/partners?zone=${z.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light"><Users className="h-4 w-4" /> Partners</Link>
                      {z.partners === 0 && <Button size="sm" variant="ghost" onClick={() => remove(z)} aria-label={`Delete ${z.name}`}><Trash2 className="h-4 w-4" /></Button>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "New delivery zone" : `Edit ${edit?.name ?? ""}`} wide>
        {edit !== null && <ZoneForm zone={edit === "new" ? null : edit} onDone={() => { setEdit(null); toast("Zone saved"); load(); }} />}
      </Modal>
    </div>
  );
}

function ZoneForm({ zone, onDone }: { zone: Zone | null; onDone: () => void }) {
  const [f, setF] = useState({
    name: zone?.name ?? "", city: zone?.city ?? "", pins: zone?.pincodes.join(", ") ?? "", is_active: zone?.is_active ?? true,
    lat: zone?.center_lat?.toString() ?? "", lng: zone?.center_lng?.toString() ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pins = Array.from(new Set(f.pins.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)));
  const bad = pins.filter((p) => !/^[1-9]\d{5}$/.test(p));
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: f.name, city: f.city, pincodes: pins, is_active: f.is_active, center_lat: f.lat ? Number(f.lat) : null, center_lng: f.lng ? Number(f.lng) : null };
    try {
      if (zone) await api(`/api/admin/delivery/zones/${zone.id}`, { method: "PUT", body });
      else await api("/api/admin/delivery/zones", { method: "POST", body });
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save the zone");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><ErrorNote message={error} /></div>
      <TextField label="Zone name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={80} placeholder="e.g. Coimbatore Central" />
      <TextField label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} required minLength={2} maxLength={80} />
      <Field label={`PIN codes (${pins.length})`} className="sm:col-span-2" error={bad.length ? `Not 6-digit PIN codes: ${bad.slice(0, 5).join(", ")}` : undefined}
        hint="Separate with commas, spaces or new lines. A PIN code can be in only one active zone.">
        <Textarea rows={4} value={f.pins} onChange={(e) => setF({ ...f, pins: e.target.value })} required className="font-mono text-sm" placeholder="641001, 641002, 641018" />
      </Field>
      <TextField label="Map centre latitude (optional)" inputMode="decimal" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} placeholder="11.0168" />
      <TextField label="Map centre longitude (optional)" inputMode="decimal" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} placeholder="76.9558" />
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Zone is active (switching it off takes its partners offline)</label>
      <Button type="submit" loading={busy} disabled={bad.length > 0 || pins.length === 0} className="sm:col-span-2 sm:justify-self-start">Save zone</Button>
    </form>
  );
}
