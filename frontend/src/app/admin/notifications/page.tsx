"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, Stat } from "@/components/portal-shell";
import { Button, ErrorNote, Field, PageLoader, Pill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type T = { event: string; channel: "inapp" | "email" | "sms" | "whatsapp"; customised: boolean; subject: string; body: string; provider_template: string; is_active: boolean };
type D = { items: T[]; delivery: Record<string, number>; channels: { email: boolean; sms: boolean; whatsapp: boolean } };

const CHANNEL: Record<string, string> = { inapp: "In the app", email: "Email", sms: "SMS", whatsapp: "WhatsApp" };
const EVENT: Record<string, string> = {
  order_placed: "Order placed", order_shipped: "Order shipped", order_delivered: "Order delivered", order_cancelled: "Order cancelled",
  refund_processed: "Refund processed", return_update: "Return status changed", ticket_reply: "Support replied",
  seller_new_order: "Seller: new order", seller_order_cancelled: "Seller: order cancelled", seller_return_requested: "Seller: return requested",
  seller_kyc_update: "Seller: verification result", listing_update: "Seller: listing reviewed", payout_sent: "Seller: payout sent", low_stock: "Seller: low stock",
};
const label = (e: string) => EVENT[e] ?? e.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export default function NotificationTemplates() {
  const toast = useToast();
  const [d, setD] = useState<D | null>(null);
  const [sel, setSel] = useState<{ event: string; channel: string } | null>(null);
  const [f, setF] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<D>("/api/admin/notifications/templates").then((x) => { setD(x); return x; });
  useEffect(() => { load().then((x) => { const t = x.items[0]; if (t) { setSel(t); setF(t); } }); }, []);
  const events = useMemo(() => Array.from(new Set(d?.items.map((t) => t.event) ?? [])), [d]);

  async function save() {
    if (!f) return;
    setError(null);
    try {
      await api(`/api/admin/notifications/templates/${f.event}/${f.channel}`, { method: "PUT", body: { subject: f.subject, body: f.body, provider_template: f.provider_template, is_active: f.is_active } });
      toast("Template saved");
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  if (!d) return <PageLoader />;
  const vars = f ? Array.from(new Set((f.body + " " + f.subject).match(/\{\{[a-z_]+\}\}/g) ?? [])) : [];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Customer and seller messages" sub="What we send when something happens to an order, return or account. Order updates are always sent; offers only to people who agreed." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {(["email", "sms", "whatsapp"] as const).map((c) => <Stat key={c} label={CHANNEL[c]} value={d.channels[c] ? "Connected" : "Not set up"} hint={d.channels[c] ? undefined : "Add keys in the server settings"} />)}
        <Stat label="Sent" value={(d.delivery.sent ?? 0).toLocaleString("en-IN")} />
        <Stat label="Failed" value={(d.delivery.failed ?? 0).toLocaleString("en-IN")} hint={d.delivery.pending ? `${d.delivery.pending} waiting` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="max-h-[70vh] self-start overflow-auto rounded-xl bg-white p-2">
          {events.map((e) => (
            <div key={e} className="mb-1">
              <p className="px-2 pt-2 text-sm font-semibold">{label(e)}</p>
              <div className="flex flex-wrap gap-1 px-2 pb-1">
                {d.items.filter((t) => t.event === e).map((t) => (
                  <button key={t.channel} onClick={() => { setSel(t); setF(t); setError(null); }} className={`rounded-full px-2.5 py-0.5 text-xs ${sel?.event === e && sel.channel === t.channel ? "bg-peacock text-white" : t.is_active ? "bg-peacock-light text-peacock" : "bg-mist text-ink-faint"}`}>
                    {CHANNEL[t.channel]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </aside>
        {f && (
          <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{label(f.event)}, {CHANNEL[f.channel]}</h2>
              {f.customised ? <Pill tone="blue">Edited</Pill> : <Pill tone="gray">Default text</Pill>}
            </div>
            <ErrorNote message={error} />
            {f.channel === "email" && <TextField label="Subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={200} />}
            <Field label="Message" hint={f.channel === "sms" ? "SMS in India must match a DLT-approved template word for word. Keep this text identical to your approved template." : undefined}>
              <Textarea rows={7} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={5000} />
            </Field>
            {vars.length > 0 && <p className="text-sm text-ink-soft">Filled in automatically: {vars.join(", ")}</p>}
            {(f.channel === "sms" || f.channel === "whatsapp") && (
              <TextField label={f.channel === "sms" ? "MSG91 flow ID" : "WhatsApp template name"} value={f.provider_template} onChange={(e) => setF({ ...f, provider_template: e.target.value })} hint={f.channel === "sms" ? "From MSG91 → Flow, linked to the DLT template" : "Approved template name in Meta WhatsApp Manager. Its variables are filled in the order they appear above."} />
            )}
            <label className="flex items-center gap-2"><input type="checkbox" className="accent-peacock" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Send this message</label>
            <Button className="self-start" onClick={save}>Save template</Button>
          </section>
        )}
      </div>
    </div>
  );
}
