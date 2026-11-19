"use client";

import { ChevronDown, LifeBuoy, MessageCircle, Phone } from "lucide-react";
import Link from "next/link";
import { useDeliveryOptions } from "@/components/delivery/app";

const FAQ: [string, string][] = [
  ["I did not get any requests", "Make sure you are Online, your phone's location is on and the partner app is open (or installed). Requests go to partners near the store first."],
  ["How long do I have to accept a request?", "The timer on the request shows the seconds left. If you do not accept in time, the request goes to the next partner."],
  ["The seller does not have my pickup code", "The pickup code is on the seller's order screen. Ask them to open the order; if it still does not match, call the delivery team."],
  ["The customer is not answering", "Call them from the order screen. If you cannot reach them, mark the attempt as failed with the reason; the team will plan the next try."],
  ["The customer has no OTP", "The OTP is on the customer's order page and in their SMS. Do not hand over the package without it."],
  ["When are payouts made?", "Every week for the deliveries of the previous Monday to Sunday. You can see each payout in Earnings."],
  ["How do I deposit cash collected?", "Hand it to the delivery team or pay by UPI to the business account. The team records it and your cash in hand goes down."],
];

export default function PartnerHelp() {
  const o = useDeliveryOptions();
  const wa = o?.support_whatsapp?.replace(/\D/g, "");
  return (
    <div className="flex flex-col gap-4 pt-2" data-testid="partner-help">
      <section className="rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-6 text-white shadow-sm">
        <LifeBuoy className="h-9 w-9" aria-hidden />
        <h1 className="mt-2 text-2xl font-bold">How can we help?</h1>
        <p className="text-white/80">The delivery team is here for you during deliveries.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {o?.support_phone ? (
            <a href={`tel:${o.support_phone}`} className="flex items-center justify-center gap-2 rounded-xl bg-white py-3 font-semibold text-peacock"><Phone className="h-5 w-5" /> Call {o.support_phone}</a>
          ) : null}
          {wa ? (
            <a href={`https://wa.me/${wa.length === 10 ? `91${wa}` : wa}`} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 rounded-xl bg-leaf py-3 font-semibold text-white"><MessageCircle className="h-5 w-5" /> WhatsApp us</a>
          ) : null}
          <Link href="/support" className="flex items-center justify-center gap-2 rounded-xl bg-white/15 py-3 font-semibold ring-1 ring-white/40">Write to support</Link>
        </div>
      </section>
      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="text-lg font-semibold">Common questions</h2>
        <div className="mt-2 divide-y divide-line">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">{q}<ChevronDown className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" aria-hidden /></summary>
              <p className="mt-2 text-ink-soft">{a}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
