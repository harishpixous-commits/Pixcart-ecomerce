"use client";

/* Coupons and offers at checkout: type a code or pick one of the offers on show. The server checks every code. */

import { BadgePercent, CircleAlert, CircleCheck, Tag, TicketPercent } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui";
import { date, rupees } from "@/lib/format";
import { Card, CardHeading } from "./card";

export type OfferCoupon = { code: string; description: string; min_order_paise: number; max_discount_paise?: number | null; ends_at?: string | null };
export type AppliedCoupon = { code: string; discount: number; description?: string };

export function CouponSection({ applied, error, offers, checking, onApply, onRemove, onEdit }: {
  applied: AppliedCoupon | null;
  error: { code: string; message: string } | null;
  offers: OfferCoupon[];
  /** A code is being checked (the bill is being worked out again). */
  checking: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
  /** The shopper is typing a new code: clears the last error. */
  onEdit: () => void;
}) {
  const [text, setText] = useState("");

  return (
    <Card labelledBy="co-coupon-h" testId="checkout-coupons">
      <CardHeading id="co-coupon-h" icon={TicketPercent} tone="marigold" title="Coupons and offers" sub={applied ? undefined : "Apply a code to save on this order."} />
      {applied ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-leaf/50 bg-leaf-light p-3" data-testid="coupon-applied">
          <CircleCheck className="h-6 w-6 shrink-0 text-leaf" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">
              <span className="tracking-wide text-leaf">{applied.code}</span> applied
            </p>
            <p className="text-sm text-ink-soft">
              You save <span className="font-semibold text-leaf">{rupees(applied.discount)}</span>
              {applied.description ? ` · ${applied.description}` : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText("");
              onRemove();
            }}
          >
            Remove
          </Button>
        </div>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) onApply(text.trim());
            }}
          >
            <label htmlFor="co-coupon" className="sr-only">Coupon code</label>
            <div className="relative min-w-0 flex-1">
              <Tag className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
              <input
                id="co-coupon"
                value={text}
                onChange={(e) => {
                  setText(e.target.value.toUpperCase());
                  onEdit();
                }}
                placeholder="Enter coupon code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={30}
                aria-invalid={!!error}
                aria-describedby={error ? "co-coupon-error" : undefined}
                className="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 font-semibold uppercase tracking-wide text-ink placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-faint focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20"
              />
            </div>
            <Button type="submit" variant="secondary" loading={checking} disabled={!text.trim()}>Apply</Button>
          </form>
          {error && (
            <p id="co-coupon-error" role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-vermilion">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span><span className="font-semibold">{error.code}:</span> {error.message}</span>
            </p>
          )}
          {offers.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Available offers</p>
              <ul className="flex flex-col gap-2">
                {offers.map((o) => (
                  <li key={o.code} className="flex items-center gap-3 rounded-xl border border-dashed border-peacock/40 bg-peacock-light/30 p-3">
                    <BadgePercent className="h-5 w-5 shrink-0 text-peacock" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold tracking-wide text-peacock">{o.code}</p>
                      {o.description && <p className="text-sm leading-snug text-ink-soft">{o.description}</p>}
                      {(o.min_order_paise > 0 || o.ends_at) && (
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {[o.min_order_paise > 0 ? `On orders of ${rupees(o.min_order_paise)} or more` : "", o.ends_at ? `Valid till ${date(o.ends_at)}` : ""].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Apply ${o.code}`}
                      disabled={checking}
                      onClick={() => {
                        setText(o.code);
                        onApply(o.code);
                      }}
                    >
                      Apply
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}
