"use client";

import { useEffect, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Modal, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date, paiseToInput, rupees, toLocalInput, toPaise } from "@/lib/format";

export type CouponRow = {
  id: string; code: string; description: string; kind: "percent" | "flat"; value: number; max_discount_paise: number | null; min_order_paise: number;
  starts_at: string | null; ends_at: string | null; usage_limit: number | null; per_user_limit: number; used_count: number; funded_by: string;
  category_id: string | null; first_order_only: boolean; is_active: boolean; show_on_checkout: boolean; is_automatic?: boolean;
};

export function couponSummary(c: Pick<CouponRow, "kind" | "value" | "max_discount_paise" | "min_order_paise">) {
  const off = c.kind === "percent" ? `${c.value / 100}% off` : `${rupees(c.value)} off`;
  const cap = c.kind === "percent" && c.max_discount_paise ? ` up to ${rupees(c.max_discount_paise)}` : "";
  const min = c.min_order_paise ? ` on ${rupees(c.min_order_paise)} or more` : "";
  return off + cap + min;
}

// The form shows the browser's local time; toISOString() would show UTC and shift the time on every save.
const toLocal = (iso: string | null) => toLocalInput(iso);

/** Coupon list and editor shared by the seller hub (seller-funded) and the admin (platform-funded). */
export function CouponManager({ base, admin }: { base: string; admin?: boolean }) {
  const toast = useToast();
  const [now] = useState(() => Date.now());
  const [rows, setRows] = useState<CouponRow[] | null>(null);
  const [edit, setEdit] = useState<CouponRow | "new" | null>(null);
  const [batch, setBatch] = useState({ count: "10", prefix: "", single: true });
  const [batchCodes, setBatchCodes] = useState("");
  const [cats, setCats] = useState<{ id: string; path?: string; name?: string }[]>([]);
  const [f, setF] = useState({ code: "", description: "", kind: "percent", value: "10", max: "", min: "", starts: "", ends: "", limit: "", per_user: "1", category_id: "", first_order_only: false, show_on_checkout: true, is_automatic: false, is_active: true });
  const [error, setError] = useState<string | null>(null);
  const load = () => api<CouponRow[]>(base).then(setRows).catch(quietly);
  useEffect(() => {
    load();
    if (admin) api<{ id: string; path?: string; name?: string }[]>("/api/admin/categories").then(setCats).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  function open(c: CouponRow | "new") {
    setError(null);
    setEdit(c);
    if (c === "new") setF({ code: "", description: "", kind: "percent", value: "10", max: "", min: "", starts: "", ends: "", limit: "", per_user: "1", category_id: "", first_order_only: false, show_on_checkout: true, is_automatic: false, is_active: true });
    else setF({
      code: c.code, description: c.description, kind: c.kind, value: c.kind === "percent" ? String(c.value / 100) : paiseToInput(c.value),
      max: c.max_discount_paise ? paiseToInput(c.max_discount_paise) : "", min: c.min_order_paise ? paiseToInput(c.min_order_paise) : "",
      starts: toLocal(c.starts_at), ends: toLocal(c.ends_at), limit: c.usage_limit ? String(c.usage_limit) : "", per_user: String(c.per_user_limit),
      category_id: c.category_id ?? "", first_order_only: c.first_order_only, show_on_checkout: c.show_on_checkout, is_automatic: !!c.is_automatic, is_active: c.is_active,
    });
  }

  async function makeCopies(id: string) {
    try {
      const r = await api<{ count: number; codes: string[] }>(`${base}/${id}/generate`, { method: "POST", body: { count: Number(batch.count), prefix: batch.prefix, single_use: batch.single } });
      setBatchCodes(r.codes.join("\n"));
      toast(`${r.count} codes made`);
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not make the codes", "error");
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = f.kind === "percent" ? Math.round(Number(f.value) * 100) : toPaise(f.value);
    if (!value || value <= 0) return setError("Enter the discount");
    const body: Record<string, unknown> = {
      code: f.code, description: f.description, kind: f.kind, value,
      max_discount_paise: f.kind === "percent" && f.max ? toPaise(f.max) : null, min_order_paise: f.min ? toPaise(f.min) ?? 0 : 0,
      starts_at: f.starts ? new Date(f.starts).toISOString() : null, ends_at: f.ends ? new Date(f.ends).toISOString() : null,
      usage_limit: f.limit ? Number(f.limit) : null, per_user_limit: Number(f.per_user) || 1, is_active: f.is_active,
    };
    if (admin) Object.assign(body, { category_id: f.category_id || null, first_order_only: f.first_order_only, show_on_checkout: f.show_on_checkout, is_automatic: f.is_automatic });
    try {
      if (edit === "new") await api(base, { method: "POST", body });
      else await api(`${base}/${(edit as CouponRow).id}`, { method: "PUT", body });
      toast("Coupon saved");
      setEdit(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  const state = (c: CouponRow) =>
    !c.is_active ? <Pill tone="gray">Off</Pill>
      : c.ends_at && new Date(c.ends_at).getTime() < now ? <Pill tone="red">Ended</Pill>
      : c.starts_at && new Date(c.starts_at).getTime() > now ? <Pill tone="blue">Scheduled</Pill>
      : c.usage_limit && c.used_count >= c.usage_limit ? <Pill tone="red">Used up</Pill>
      : <Pill tone="green">Live</Pill>;

  return (
    <div>
      <PageHeader
        title="Coupons"
        sub={admin ? "Platform-funded offers: the discount comes out of the platform's commission, sellers are paid on the full price." : "Your own offers: the discount is taken from your sale value, and commission and tax are on the discounted price."}
        actions={<Button onClick={() => open("new")}>New coupon</Button>}
      />
      {!rows ? <PageLoader /> : rows.length === 0 ? <EmptyState title="No coupons yet" body="Create a coupon to run a sale or welcome new customers." /> : (
        <Table head={["Code", "Offer", "Valid", "Used", admin ? "Funded by" : "", "Status"].filter(Boolean)}>
          {rows.map((c) => (
            <tr key={c.id} className="cursor-pointer hover:bg-mist/60" onClick={() => open(c)}>
              <td className="px-4 py-2.5"><p className="font-semibold text-peacock">{c.code}</p><p className="text-sm text-ink-faint">{c.description}</p></td>
              <td className="px-4 py-2.5 text-sm">{couponSummary(c)}{c.first_order_only ? ", first order only" : ""}</td>
              <td className="px-4 py-2.5 text-sm">{c.starts_at ? date(c.starts_at) : "Now"} to {c.ends_at ? date(c.ends_at) : "no end"}</td>
              <td className="px-4 py-2.5 text-sm">{c.used_count}{c.usage_limit ? ` of ${c.usage_limit}` : ""}</td>
              {admin && <td className="px-4 py-2.5 text-sm">{c.funded_by === "seller" ? "Seller" : "Platform"}</td>}
              <td className="px-4 py-2.5">{state(c)}</td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "New coupon" : `Edit ${(edit as CouponRow | null)?.code ?? ""}`} wide>
        {edit && edit !== "new" && edit.funded_by === "seller" && admin ? (
          <p className="text-ink-soft">This coupon belongs to a seller. Sellers manage their own coupons.</p>
        ) : (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote message={error} /></div>
            <TextField label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} required minLength={4} maxLength={30} disabled={edit !== "new"} hint="Letters and numbers, e.g. DIWALI20" />
            <TextField label="Short description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} hint="Shown to customers at checkout" />
            <Field label="Discount type" htmlFor="ck">
              <Select id="ck" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Percentage</option><option value="flat">Fixed amount</option></Select>
            </Field>
            <TextField label={f.kind === "percent" ? "Percentage off (1 to 90)" : "Amount off (₹)"} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required />
            {f.kind === "percent" && <TextField label="Maximum discount (₹, optional)" inputMode="decimal" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} />}
            <TextField label="Minimum order (₹, optional)" inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} hint={admin ? "Counted on the whole cart" : "Counted on your items in the cart"} />
            <TextField label="Starts" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} />
            <TextField label="Ends" type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} />
            <TextField label="Total uses allowed (optional)" inputMode="numeric" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value.replace(/\D/g, "") })} />
            <TextField label="Uses per customer" inputMode="numeric" value={f.per_user} onChange={(e) => setF({ ...f, per_user: e.target.value.replace(/\D/g, "") })} />
            {admin && (
              <>
                <Field label="Only for a category (optional)" htmlFor="cc" className="sm:col-span-2">
                  <Select id="cc" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
                    <option value="">All categories</option>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.path ?? c.name}</option>)}
                  </Select>
                </Field>
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={f.first_order_only} onChange={(e) => setF({ ...f, first_order_only: e.target.checked })} /> First order only</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={f.show_on_checkout} onChange={(e) => setF({ ...f, show_on_checkout: e.target.checked })} /> Show in the offers list at checkout</label>
                <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={f.is_automatic} onChange={(e) => setF({ ...f, is_automatic: e.target.checked })} /> Apply automatically, no code needed (needs Growth, Automatic discounts, switched on)</label>
              </>
            )}
            <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="accent-peacock" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Coupon is on</label>
            <Button type="submit" className="self-start">Save coupon</Button>
            {admin && edit && edit !== "new" && (
              <div className="rounded-lg border border-line p-3 sm:col-span-2" data-testid="coupon-batch">
                <p className="font-semibold">Make copies with their own codes</p>
                <p className="mb-2 text-sm text-ink-soft">Each copy has the same offer and a random code. Single-use copies work once in total and stay off the offers list. Save any changes above first.</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label="How many (1 to 200)" inputMode="numeric" value={batch.count} onChange={(e) => setBatch({ ...batch, count: e.target.value.replace(/\D/g, "") })} />
                  <TextField label="Code starts with" value={batch.prefix} onChange={(e) => setBatch({ ...batch, prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} minLength={2} maxLength={10} />
                  <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="accent-peacock" checked={batch.single} onChange={(e) => setBatch({ ...batch, single: e.target.checked })} /> Single use each</label>
                </div>
                <Button type="button" className="mt-2" onClick={() => makeCopies(edit.id)}>Make codes</Button>
                {batchCodes && <textarea readOnly rows={6} className="mt-2 w-full rounded-lg border border-line p-2 font-mono text-sm" value={batchCodes} aria-label="New codes" />}
              </div>
            )}
          </form>
        )}
      </Modal>
    </div>
  );
}
