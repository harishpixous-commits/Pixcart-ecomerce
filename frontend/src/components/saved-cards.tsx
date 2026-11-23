"use client";

/*
 * Account → Saved cards. Cards are saved by Razorpay, inside its payment window, when the shopper ticks "Save this card"
 * (RBI card-on-file tokenisation): the card network keeps a token, and neither this site nor Razorpay keeps the card
 * number. Next time Razorpay offers the saved card; the shopper confirms with the CVV and the bank's OTP, as RBI requires.
 * Here they see the last 4 digits, network and expiry, and can remove a card.
 */

import { CreditCard, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { networkKey, PayLogo, NETWORK_NAMES } from "@/components/pay-logos";
import { Button, Modal, Spinner, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type Card = {
  id: string; last4: string; network: string; issuer: string; type: string; name: string;
  expiry_month: number | null; expiry_year: number | null; international: boolean; used_at: number | null;
};

export function SavedCards() {
  const toast = useToast();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ enabled: boolean; items: Card[] }>("/api/account/cards")
      .then((r) => { setCards(r.items); setEnabled(r.enabled); setError(null); })
      .catch((e) => { setCards([]); setError(e instanceof ApiError ? e.message : "Could not load your saved cards"); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/api/account/cards/${removing.id}`, { method: "DELETE" });
      toast("Card removed");
      setRemoving(null);
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not remove the card", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!enabled && !cards?.length) return null;
  return (
    <section className="rounded-xl bg-white p-5" data-testid="saved-cards" aria-labelledby="cards-h">
      <h2 id="cards-h" className="mb-1 flex items-center gap-2 text-xl font-semibold"><CreditCard className="h-5 w-5 text-peacock" aria-hidden /> Saved cards</h2>
      <p className="mb-3 flex items-start gap-1.5 text-sm text-ink-soft">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-leaf" aria-hidden />
        Saved securely by Razorpay as RBI requires: your card number is never stored on this site. To save a card, tick
        &quot;Save this card&quot; when you pay. You confirm each payment with your CVV and your bank&apos;s OTP.
      </p>
      {cards === null ? <Spinner /> : error ? (
        <p className="text-sm text-vermilion" role="alert">{error}</p>
      ) : cards.length === 0 ? (
        <p className="rounded-lg bg-mist px-3 py-3 text-sm text-ink-soft">No saved cards yet.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          {cards.map((c) => {
            const key = networkKey(c.network);
            const exp = c.expiry_month && c.expiry_year ? `${String(c.expiry_month).padStart(2, "0")}/${String(c.expiry_year).slice(-2)}` : "";
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-3 rounded-xl p-3 ring-1 ring-line" data-testid="saved-card">
                <PayLogo name={key} className="h-9 w-14" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold" translate="no">{NETWORK_NAMES[key] ?? c.network} •••• {c.last4}</p>
                  <p className="truncate text-sm text-ink-soft">
                    {[c.issuer, c.type && `${c.type} card`, exp && `expires ${exp}`].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(c)}>Remove</Button>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove this card?">
        <p className="text-ink-soft">
          {removing && <>The card ending <span className="font-semibold text-ink" translate="no">{removing.last4}</span> will no longer be offered when you pay. You can save it again next time.</>}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(null)}>Keep it</Button>
          <Button variant="danger" onClick={remove} loading={busy}>Remove card</Button>
        </div>
      </Modal>
    </section>
  );
}
