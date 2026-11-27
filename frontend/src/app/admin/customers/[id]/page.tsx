"use client";

import { ArrowLeft, LogOut, Pencil, ShieldOff, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, Stat, Table } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Modal, PageLoader, Pill, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";

type Loyalty = { enabled: boolean; balance: number; lifetime: number; tier: string; value_paise: number; history: { kind: string; points: number; note: string; at: string }[] };

type Detail = {
  id: string; name: string; phone: string | null; email: string | null; is_active: boolean; is_admin: boolean; marketing_opt_in: boolean;
  created_at: string; last_login_at: string | null; terms_accepted_at: string | null;
  seller: { id: string; name: string; status: string } | null;
  stats: { orders: number; spent: number; returns: number; tickets: number; open_tickets: number; wishlist: number; reviews: number };
  addresses: { id: string; name: string; phone: string; kind: string; is_default: boolean; text: string }[];
  orders: { id: string; number: string; status: string; payment_method: string; grand_total: number; created_at: string; item_count: number; sub_statuses: string[] }[];
  returns: { id: string; number: string; status: string; reason_label: string; refund_amount: number; sub_order_number: string; order_id: string; created_at: string }[];
  tickets: { id: string; number: string; subject: string; status: string; updated_at: string }[];
  sessions: { device: string; signed_in_at: string; expires_at: string }[];
  history: { action: string; detail: string; by: string; at: string }[];
};

const ACTIONS: Record<string, string> = {
  "user.create": "Account created", "user.edit": "Details changed", "user.block": "Blocked", "user.unblock": "Unblocked",
  "user.sign_out": "Signed out everywhere", "staff.create": "Made staff", "staff.update": "Staff access changed",
};

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canOrders = useCan("orders");
  const canSupport = useCan("support");
  const canMarketing = useCan("marketing");
  const [loy, setLoy] = useState<Loyalty | null>(null);
  const [pts, setPts] = useState("");
  const [ptsNote, setPtsNote] = useState("");
  const loadLoyalty = useCallback(() => { if (canMarketing) api<Loyalty>(`/api/admin/growth/loyalty/${id}`).then(setLoy).catch(quietly); }, [id, canMarketing]);
  useEffect(() => { loadLoyalty(); }, [loadLoyalty]);
  async function adjust(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setLoy(await api<Loyalty>("/api/admin/growth/loyalty/adjust", { method: "POST", body: { user_id: id, points: Number(pts), note: ptsNote.trim() } }));
      setPts("");
      setPtsNote("");
      toast("Points updated");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not update points");
    } finally {
      setBusy(false);
    }
  }
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", email: "", marketing: false });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Detail>(`/api/admin/customers/${id}`).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load")), [id]);
  useEffect(() => { load(); }, [load]);

  function openEdit() {
    if (!d) return;
    setF({ name: d.name, phone: d.phone ?? "", email: d.email ?? "", marketing: d.marketing_opt_in });
    setFieldErrors({});
    setError(null);
    setEditing(true);
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: f.name, phone: f.phone, marketing_opt_in: f.marketing };
      if (f.email.trim()) body.email = f.email.trim();
      else if (d.email) body.clear_email = true;
      setD(await api<Detail>(`/api/admin/customers/${id}`, { method: "PATCH", body }));
      toast(f.phone.replace(/\D/g, "").slice(-10) !== d.phone ? "Saved. The new mobile number must sign in again." : "Saved");
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
      if (err instanceof ApiError) setFieldErrors(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (!window.confirm("Sign this person out on every device? They can sign in again with a one-time code.")) return;
    const r = await api<{ sessions: number }>(`/api/admin/customers/${id}/sign-out`, { method: "POST" }).catch((e) => { toast(e instanceof ApiError ? e.message : "Failed", "error"); return null; });
    if (r) { toast(`Signed out of ${r.sessions} device(s)`); load(); }
  }
  async function block() {
    setBusy(true);
    try {
      await api(`/api/admin/customers/${id}/block`, { method: "POST", body: { reason } });
      toast("Account blocked and signed out everywhere");
      setBlocking(false);
      setReason("");
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }
  async function unblock() {
    await api(`/api/admin/customers/${id}/unblock`, { method: "POST" }).then(() => { toast("Account unblocked"); load(); }).catch(quietly);
  }

  if (!d) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <Link href="/admin/customers" className="inline-flex items-center gap-1 text-sm font-semibold text-peacock"><ArrowLeft className="h-4 w-4" />All accounts</Link>
      <PageHeader title={d.name || "No name yet"} sub={[d.phone && `+91 ${d.phone}`, d.email].filter(Boolean).join(" · ")}
        actions={<>
          {!d.is_admin && <Button variant="secondary" onClick={openEdit}><Pencil className="h-4 w-4" />Edit</Button>}
          <Button variant="secondary" onClick={signOut} disabled={!d.sessions.length}><LogOut className="h-4 w-4" />Sign out everywhere</Button>
          {!d.is_admin && (d.is_active
            ? <Button variant="danger" onClick={() => setBlocking(true)}><ShieldOff className="h-4 w-4" />Block</Button>
            : <Button onClick={unblock}><ShieldCheck className="h-4 w-4" />Unblock</Button>)}
        </>} />
      <div className="flex flex-wrap items-center gap-2">
        {d.is_active ? <Pill tone="green">Active</Pill> : <Pill tone="red">Blocked</Pill>}
        {d.is_admin && <Pill tone="blue">Staff: manage in <Link href="/admin/staff" className="underline">Staff and roles</Link></Pill>}
        {d.seller && <Link href={`/admin/sellers/${d.seller.id}`}><Pill tone="gray">Seller: {d.seller.name} ({d.seller.status})</Pill></Link>}
      </div>
      <ErrorNote message={error && !editing ? error : null} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Orders" value={d.stats.orders} />
        <Stat label="Spent (after refunds)" value={rupees(d.stats.spent)} />
        <Stat label="Returns" value={d.stats.returns} />
        <Stat label="Support requests" value={d.stats.tickets} hint={d.stats.open_tickets ? `${d.stats.open_tickets} open` : undefined} />
        <Stat label="Wishlist" value={d.stats.wishlist} />
        <Stat label="Reviews" value={d.stats.reviews} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Account">
          <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-[15px]">
            <dt className="text-ink-faint">Joined</dt><dd>{date(d.created_at)}</dd>
            <dt className="text-ink-faint">Last sign-in</dt><dd>{d.last_login_at ? date(d.last_login_at) : "Never"}</dd>
            <dt className="text-ink-faint">Terms accepted</dt><dd>{d.terms_accepted_at ? date(d.terms_accepted_at) : "Not yet (account made by staff)"}</dd>
            <dt className="text-ink-faint">Offers by message</dt><dd>{d.marketing_opt_in ? "Yes, opted in" : "No"}</dd>
          </dl>
        </Card>
        <Card title={`Signed in on ${d.sessions.length} device(s)`}>
          {d.sessions.length ? (
            <ul className="divide-y divide-line text-sm">{d.sessions.map((s, i) => <li key={i} className="flex justify-between py-1.5"><span>{s.device}</span><span className="text-ink-faint">since {date(s.signed_in_at)}</span></li>)}</ul>
          ) : <p className="text-sm text-ink-faint">Not signed in anywhere.</p>}
        </Card>
      </div>

      <Card title="Addresses">
        {d.addresses.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.addresses.map((a) => (
              <li key={a.id} className="rounded-lg border border-line p-3 text-sm">
                <p className="font-semibold">{a.name} <span className="font-normal text-ink-faint">· {a.phone}</span> {a.is_default && <Pill tone="green">Default</Pill>}</p>
                <p className="text-ink-soft">{a.text}</p>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-faint">No saved addresses.</p>}
      </Card>

      <Card title="Recent orders" action={canOrders ? <Link href={`/admin/orders?customer_id=${d.id}`} className="text-sm font-semibold text-peacock">All orders</Link> : undefined}>
        {d.orders.length ? (
          <Table head={["Order", "Placed", "Items", "Payment", "Total", "Packages"]}>
            {d.orders.map((o) => (
              <tr key={o.id}>
                <td className="px-4 py-2">{canOrders ? <Link href={`/admin/orders/${o.id}`} className="font-semibold text-peacock">{o.number}</Link> : o.number}</td>
                <td className="px-4 py-2 text-sm">{date(o.created_at)}</td>
                <td className="px-4 py-2">{o.item_count}</td>
                <td className="px-4 py-2 text-sm">{o.payment_method === "cod" ? "Cash on delivery" : "Online"}</td>
                <td className="px-4 py-2">{rupees(o.grand_total)}</td>
                <td className="px-4 py-2"><span className="flex flex-wrap gap-1">{o.sub_statuses.map((s, i) => <StatusPill key={i} status={s} />)}</span></td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState title="No orders yet" />}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Returns">
          {d.returns.length ? (
            <ul className="divide-y divide-line text-sm">{d.returns.map((r) => (
              <li key={r.id} className="flex justify-between gap-2 py-1.5">
                <span>{r.number} · {r.reason_label}{canOrders && <> · <Link href={`/admin/orders/${r.order_id}`} className="text-peacock">order</Link></>}</span>
                <span className="shrink-0"><StatusPill status={r.status} /></span>
              </li>
            ))}</ul>
          ) : <p className="text-sm text-ink-faint">No returns.</p>}
        </Card>
        <Card title="Support requests">
          {d.tickets.length ? (
            <ul className="divide-y divide-line text-sm">{d.tickets.map((t) => (
              <li key={t.id} className="flex justify-between gap-2 py-1.5">
                <span className="truncate">{canSupport ? <Link href={`/admin/support/${t.id}`} className="font-semibold text-peacock">{t.number}</Link> : t.number} · {t.subject}</span>
                <span className="shrink-0"><StatusPill status={t.status} /></span>
              </li>
            ))}</ul>
          ) : <p className="text-sm text-ink-faint">No support requests.</p>}
        </Card>
      </div>

      {canMarketing && loy && (
        <Card title="Loyalty points">
          <p className="text-sm" data-testid="loyalty-balance">{loy.balance} points ({rupees(loy.value_paise)}) · {loy.tier} tier · {loy.lifetime} earned in all{!loy.enabled && " · points are switched off in Growth settings"}</p>
          <form onSubmit={adjust} className="mt-3 flex flex-wrap items-end gap-2" data-testid="loyalty-adjust">
            <label className="flex flex-col gap-1 text-sm"><span className="font-semibold">Points (minus to take back)</span><input className="w-40 rounded-lg border border-line px-3 py-2" inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} /></label>
            <label className="flex flex-1 flex-col gap-1 text-sm"><span className="font-semibold">Reason (the customer sees it)</span><input className="min-w-48 rounded-lg border border-line px-3 py-2" value={ptsNote} onChange={(e) => setPtsNote(e.target.value)} /></label>
            <Button type="submit" loading={busy} disabled={!/^-?\d+$/.test(pts) || Number(pts) === 0 || ptsNote.trim().length < 3}>Apply</Button>
          </form>
          {loy.history.length > 0 && (
            <ul className="mt-3 divide-y divide-line text-sm">{loy.history.slice(0, 6).map((h, i) => (
              <li key={i} className="flex justify-between gap-3 py-1.5"><span>{h.note}</span><span className={h.points < 0 ? "text-vermilion" : "text-peacock"}>{h.points > 0 ? "+" : ""}{h.points} · {date(h.at)}</span></li>
            ))}</ul>
          )}
        </Card>
      )}

      <Card title="History">
        {d.history.length ? (
          <ul className="divide-y divide-line text-sm">{d.history.map((h, i) => (
            <li key={i} className="flex justify-between gap-2 py-1.5">
              <span><b>{ACTIONS[h.action] ?? h.action}</b>{h.detail && <span className="text-ink-soft"> · {h.detail}</span>}{h.by && <span className="text-ink-faint"> · by {h.by}</span>}</span>
              <span className="shrink-0 text-ink-faint">{date(h.at)}</span>
            </li>
          ))}</ul>
        ) : <p className="text-sm text-ink-faint">No staff changes yet.</p>}
      </Card>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit account">
        <form onSubmit={saveEdit} className="flex flex-col gap-3">
          <ErrorNote message={error} />
          <TextField label="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fieldErrors.name} required />
          <TextField label="Mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={fieldErrors.phone}
            hint="Changing it signs the customer out; they sign in again with a code sent to the new number." required />
          <TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fieldErrors.email} hint="Leave empty to remove" />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={f.marketing} onChange={(e) => setF({ ...f, marketing: e.target.checked })} />Agrees to receive offers</label>
          <Button type="submit" loading={busy}>Save</Button>
        </form>
      </Modal>
      <Modal open={blocking} onClose={() => setBlocking(false)} title={`Block ${d.name || d.phone}?`}>
        <p className="mb-2 text-sm text-ink-soft">They are signed out at once and cannot sign in or order until unblocked.</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (kept in the audit log)" aria-label="Reason" />
        <Button className="mt-3" variant="buy" loading={busy} disabled={reason.trim().length < 5} onClick={block}>Block account</Button>
      </Modal>
    </div>
  );
}
