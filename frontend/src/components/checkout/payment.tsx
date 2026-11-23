"use client";

/* Payment at checkout: the two ways to pay, the cancellation note and the bottom pay bar on phones and tablets. */

import clsx from "clsx";
import { Banknote, Check, ChevronUp, CircleAlert, Smartphone, Wallet } from "lucide-react";
import { ErrorNote } from "@/components/ui";
import { AcceptedPayments } from "@/components/pay-logos";
import { inRupees, rupees } from "@/lib/format";
import { useRegional } from "@/lib/regional";
import { Card, CardHeading, CARD } from "./card";
import { SlideToPay } from "./slide-to-pay";

export type PayMethod = "online" | "cod";

function MethodCard({ value, checked, disabled, onPick, icon, title, children, badge }: {
  value: PayMethod; checked: boolean; disabled: boolean; onPick: (m: PayMethod) => void;
  icon: React.ReactNode; title: string; children: React.ReactNode; badge?: React.ReactNode;
}) {
  return (
    <label
      className={clsx(
        "relative flex gap-3 rounded-2xl border-2 p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock has-[:focus-visible]:ring-offset-2",
        checked ? "border-peacock bg-peacock-light/40" : "border-line bg-white",
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
        !checked && !disabled && "hover:border-peacock/40",
      )}
    >
      <input type="radio" name="pay" value={value} className="sr-only" checked={checked} disabled={disabled} onChange={() => onPick(value)} />
      <span className={clsx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", checked ? "bg-peacock text-white" : "bg-mist text-peacock")} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-ink">{title}</span>
          {badge}
        </span>
        {children}
      </span>
      <span
        aria-hidden
        className={clsx(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
          checked ? "border-peacock bg-peacock text-white" : "border-line bg-white",
        )}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3.5} />}
      </span>
    </label>
  );
}

export function PaymentMethods({ method, onMethod, onlineAvailable, codAvailable, codAllowed, codMax, codFee, className, total }: {
  method: PayMethod;
  onMethod: (m: PayMethod) => void;
  onlineAvailable: boolean;
  codAvailable: boolean;
  /** false when this order is above the cash-on-delivery limit */
  codAllowed: boolean | undefined;
  codMax: number;
  /** the cash-on-delivery fee on this bill (only known once cash on delivery is chosen) */
  codFee: number;
  className?: string;
  /** the bill's total in paise: shown in rupees when the shopper browses in another currency but pays in rupees */
  total?: number;
}) {
  const { data, currency, shop } = useRegional();
  const ways = data.pay_methods;
  const foreign = shop && currency !== "INR";
  const chargedInRupees = foreign && (method === "cod" || data.charge_in === "base");
  const labels: [string, string][] = [["upi", "UPI"], ["card", "Cards"], ["netbanking", "Net banking"], ["wallet", "Wallets"], ["emi", "EMI"], ["paylater", "Pay later"]];
  const offered = labels.filter(([k]) => ways[k] !== false);
  return (
    <Card id="checkout-payment" labelledBy="co-pay-h" testId="checkout-payment" className={className}>
      <CardHeading id="co-pay-h" icon={Wallet} title="Payment method" />
      <fieldset>
        <legend className="sr-only">Choose how to pay</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <MethodCard
            value="online"
            checked={method === "online"}
            disabled={!onlineAvailable}
            onPick={onMethod}
            icon={<Smartphone className="h-5 w-5" />}
            title="Pay online"
            badge={onlineAvailable ? <span className="rounded-full bg-leaf-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-leaf">Instant</span> : null}
          >
            <span className="mt-0.5 block text-sm leading-snug text-ink-soft">
              {onlineAvailable ? `${offered.map(([, t]) => t).join(", ").replace(/, ([^,]*)$/, " and $1")} via Razorpay` : "Not available right now"}
            </span>
            {onlineAvailable && (
              <span className="mt-2 flex flex-wrap gap-1.5" aria-hidden>
                {offered.map(([k, t]) => (
                  <span key={k} className="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft ring-1 ring-line">{t}</span>
                ))}
              </span>
            )}
          </MethodCard>
          <MethodCard
            value="cod"
            checked={method === "cod"}
            disabled={!codAvailable}
            onPick={onMethod}
            icon={<Banknote className="h-5 w-5" />}
            title="Cash on delivery"
          >
            <span className="mt-0.5 block text-sm leading-snug text-ink-soft">
              {!codAvailable
                ? "Not available right now"
                : codAllowed === false && method !== "cod"
                  ? `For orders up to ${rupees(codMax)}`
                  : `Pay when each package arrives${method === "cod" && codFee ? ` (+${rupees(codFee)} fee)` : ""}`}
            </span>
          </MethodCard>
        </div>
      </fieldset>
      {onlineAvailable && (
        <AcceptedPayments className="mt-3" networks={data.card_networks} methods={ways} label="We accept" />
      )}
      {chargedInRupees && total ? (
        <p className="mt-3 rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft" data-testid="charged-in-rupees">
          Prices are shown in {currency} at today&apos;s rate. You pay <span className="font-semibold text-ink" translate="no">{inRupees(total)}</span> in Indian rupees
          {method === "cod" ? " in cash" : "; your bank converts it"}.
        </p>
      ) : null}
      {method === "cod" && codAllowed === false && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion" role="alert">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Cash on delivery is available up to {rupees(codMax)}. Please pay online for this order.
        </p>
      )}
    </Card>
  );
}

export function CancellationNote({ note }: { note: string }) {
  return (
    <section aria-labelledby="co-cancel-h" className={CARD} data-testid="checkout-cancellation">
      <h2 id="co-cancel-h" className="font-sans text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Cancellation policy</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        <span className="font-bold text-vermilion">NOTE:</span> {note}
      </p>
    </section>
  );
}

/**
 * The pay bar under the page on phones and tablets (hidden from lg up, where the bill column has its own button).
 * It is sticky, not fixed: it stays at the bottom of the screen while the checkout scrolls and settles at the end of
 * the page, so it never sits on top of the last section or the footer.
 */
export function PayBar({ method, total, onChange, onConfirm, disabled, loading, notice, error }: {
  method: PayMethod;
  /** grand total in paise (null until the bill is ready) */
  total: number | null;
  onChange: () => void;
  onConfirm: () => void;
  disabled: boolean;
  loading: boolean;
  notice: string | null;
  error: string | null;
}) {
  const amount = total !== null ? rupees(total) : "";
  const online = method === "online";
  return (
    <div
      className="sticky bottom-0 z-40 -mx-3 border-t border-line bg-white/95 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(27,36,48,0.10)] backdrop-blur sm:-mx-4 sm:px-4 lg:hidden"
      data-testid="checkout-pay-bar"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
        {notice && !error && (
          <p className="flex items-start gap-1.5 text-sm font-medium text-vermilion">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {notice}
          </p>
        )}
        <ErrorNote message={error} />
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 items-center gap-3 sm:flex-1">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock" aria-hidden>
              {online ? <Smartphone className="h-5 w-5" /> : <Banknote className="h-5 w-5" />}
            </span>
            {/* One text node after the caption, so "Cash on delivery" alone stays unique to the payment card. */}
            <p className="min-w-0 flex-1 truncate font-semibold leading-tight text-ink">
              <span className="block text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">Pay using</span>{" "}
              {online ? "Online payment" : "Cash on delivery"}
            </p>
            <a
              href="#checkout-payment"
              onClick={(e) => {
                e.preventDefault();
                onChange();
              }}
              className="flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light"
            >
              Change <ChevronUp className="h-4 w-4" aria-hidden />
            </a>
          </div>
          <SlideToPay
            className="sm:w-[360px] sm:shrink-0"
            label={
              online ? (
                <>
                  Slide to pay <span className="mx-1.5 opacity-60">|</span> {amount}
                </>
              ) : (
                "Slide to place order"
              )
            }
            ariaLabel={online ? `Slide to pay ${amount}`.trim() : "Slide to place order"}
            loadingLabel={online ? "Opening secure payment…" : "Placing your order…"}
            onConfirm={onConfirm}
            disabled={disabled}
            loading={loading}
          />
        </div>
      </div>
    </div>
  );
}
