"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ErrorNote, Input, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { dateTime } from "@/lib/format";

type Note = { id: string; note: string; author: string; at: string };

/** Private staff notes on this order. The customer and the seller never see them. */
export function StaffNotes({ orderId }: { orderId: string }) {
  const me = useAdmin();
  const allowed = !!me?.permissions.includes("orders");
  const [items, setItems] = useState<Note[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Note[] }>(`/api/admin/orders/${orderId}/notes`)).items);
    } catch {
      /* the list stays as it was */
    }
  }, [orderId]);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);
  if (!allowed) return null;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/orders/${orderId}/notes`, { method: "POST", body: { note: text } });
      setText("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-white p-4">
      <h2 className="mb-1 font-semibold">Staff notes</h2>
      <p className="mb-2 text-sm text-ink-soft">Only staff see these. They are never shown to the customer or the seller.</p>
      <ul className="mb-2 flex flex-col gap-1 text-sm">
        {items.map((n) => <li key={n.id}><span className="text-ink-faint">{dateTime(n.at)} · {n.author}</span> {n.note}</li>)}
        {items.length === 0 && <li className="text-ink-faint">No notes yet.</li>}
      </ul>
      <Textarea value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder="Add a note" aria-label="Staff note" />
      <ErrorNote message={error} />
      <Button className="mt-2" disabled={text.trim().length === 0} loading={busy} onClick={add}>Add note</Button>
    </section>
  );
}

/** Private staff labels on this order (up to 10). Saved as a whole list; the customer and the seller never see them. */
export function OrderTags({ orderId, initial }: { orderId: string; initial: string[] }) {
  const me = useAdmin();
  const [tags, setTags] = useState<string[]>(initial);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me?.permissions.includes("orders")) return null;

  async function save(next: string[]) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ staff_tags: string[] }>(`/api/admin/orders/${orderId}/tags`, { method: "PUT", body: { tags: next } });
      setTags(r.staff_tags);
      setText("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the tags");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-white p-4">
      <h2 className="mb-1 font-semibold">Tags</h2>
      <p className="mb-2 text-sm text-ink-soft">Only staff see these. Filter the order list by a tag.</p>
      <div className="mb-2 flex flex-wrap gap-1">
        {tags.map((t) => <button key={t} type="button" disabled={busy} onClick={() => save(tags.filter((x) => x !== t))} className="rounded-full bg-mist px-2 py-0.5 text-sm" aria-label={`Remove tag ${t}`}>{t} ×</button>)}
        {tags.length === 0 && <span className="text-sm text-ink-faint">No tags yet.</span>}
      </div>
      <div className="flex gap-2">
        <Input value={text} maxLength={30} onChange={(e) => setText(e.target.value)} placeholder="Add a tag" aria-label="New tag" />
        <Button disabled={text.trim().length === 0 || tags.length >= 10} loading={busy} onClick={() => save([...tags, text])}>Add</Button>
      </div>
      <ErrorNote message={error} />
    </section>
  );
}
