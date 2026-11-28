"use client";

/*
 * The optional parts of checkout that Admin → Checkout and fees switches on: delivery instructions, a tip for the
 * delivery partner, a GSTIN for a business purchase and "I don't need a bag".
 */

import clsx from "clsx";
import { BellOff, Building2, Check, ChevronDown, CircleCheck, DoorOpen, Gift, HandHeart, Leaf, NotebookPen, PawPrint, PhoneCall, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { Button, Input, TextField, Textarea } from "@/components/ui";
import { currencySymbol, paiseToShown, rupees, shownToPaise } from "@/lib/format";
import { Card, CardHeading, IconBadge } from "./card";

/* ---------------------------------------------------------------- delivery instructions */

export const MAX_INSTRUCTIONS = 300;

const QUICK_NOTES = [
  { text: "Leave at the door", icon: DoorOpen },
  { text: "Call when you arrive", icon: PhoneCall },
  { text: "Do not ring the bell", icon: BellOff },
  { text: "Hand over to security", icon: ShieldCheck },
  { text: "Pet at home", icon: PawPrint },
];

/** The sentences of an instruction ("Leave at the door. Pet at home" has two). */
function sentences(text: string): string[] {
  return text.split(/\.(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
}

function hasSentence(text: string, phrase: string): boolean {
  const p = phrase.toLowerCase();
  return sentences(text).some((s) => s.toLowerCase() === p);
}

/** Adds the phrase as its own sentence, or takes it out when it is already there. */
function toggleSentence(text: string, phrase: string): string {
  const all = sentences(text);
  const p = phrase.toLowerCase();
  const kept = all.filter((s) => s.toLowerCase() !== p);
  return (kept.length === all.length ? [...all, phrase] : kept).join(". ");
}

export function InstructionsSection({ text, onText, save, onSave }: {
  text: string; onText: (text: string) => void; save: boolean; onSave: (save: boolean) => void;
}) {
  const id = useId();
  return (
    <Card labelledBy="co-notes-h" testId="checkout-instructions">
      <CardHeading id="co-notes-h" icon={NotebookPen} title="Delivery instructions" sub="Help the delivery partner reach you." />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick instructions">
        {QUICK_NOTES.map(({ text: phrase, icon: Icon }) => {
          const on = hasSentence(text, phrase);
          const next = toggleSentence(text, phrase);
          return (
            <button
              key={phrase}
              type="button"
              aria-pressed={on}
              disabled={!on && next.length > MAX_INSTRUCTIONS}
              onClick={() => onText(next)}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                on ? "border-peacock bg-peacock-light text-peacock" : "border-line bg-white text-ink-soft hover:border-peacock/50 hover:text-ink",
              )}
            >
              {on ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
              {phrase}
            </button>
          );
        })}
      </div>
      <label htmlFor={id} className="sr-only">Instructions for the delivery partner</label>
      <Textarea
        id={id}
        value={text}
        maxLength={MAX_INSTRUCTIONS}
        rows={3}
        onChange={(e) => onText(e.target.value)}
        placeholder="E.g. Ring the bell twice. The gate code is 1234."
        className="mt-3 resize-none"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" className="h-4 w-4 accent-peacock" checked={save} onChange={(e) => onSave(e.target.checked)} />
          Save these instructions for next time
        </label>
        <span className="text-xs tabular-nums text-ink-faint">
          {text.length}/{MAX_INSTRUCTIONS}
        </span>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- tip */

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx(
        "inline-flex h-10 min-w-[4.5rem] items-center justify-center gap-1.5 rounded-xl border-2 px-3.5 text-[15px] font-semibold transition-colors",
        on ? "border-peacock bg-peacock text-white" : "border-line bg-white text-ink hover:border-peacock/50",
      )}
    >
      {children}
    </button>
  );
}

export function TipSection({ presets, max, tip, onTip }: { presets: number[]; max: number; tip: number; onTip: (paise: number) => void }) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const custom = tip > 0 && !presets.includes(tip);
  const inputId = useId();

  function choose(paise: number) {
    setOther(false);
    setError(null);
    onTip(paise);
  }

  function addOther(e: React.FormEvent) {
    e.preventDefault();
    const paise = shownToPaise(text);
    if (paise === null || paise < 100) return setError(`Enter an amount of at least ${rupees(100)}`);
    if (paise > max) return setError(`A tip can be at most ${rupees(max)}`);
    choose(paise);
  }

  return (
    <Card labelledBy="co-tip-h" testId="checkout-tip">
      <CardHeading id="co-tip-h" icon={HandHeart} tone="marigold" title="Tip your delivery partner" sub="100% of your tip goes to the delivery partner." />
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby="co-tip-h">
        {presets.map((p) => (
          <Chip key={p} on={!other && tip === p} onClick={() => choose(p)}>{rupees(p)}</Chip>
        ))}
        <Chip
          on={other || custom}
          onClick={() => {
            setText(custom ? paiseToShown(tip) : "");
            setError(null);
            setOther(true);
          }}
        >
          {custom && !other ? rupees(tip) : "Other"}
        </Chip>
        <Chip on={!other && tip === 0} onClick={() => choose(0)}>No tip</Chip>
      </div>
      {other && (
        <form onSubmit={addOther} className="mt-3 flex flex-wrap items-start gap-2" noValidate>
          <div className="relative w-36">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-semibold text-ink-soft" aria-hidden>{currencySymbol()}</span>
            <Input
              id={inputId}
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={text}
              invalid={!!error}
              aria-invalid={!!error}
              aria-describedby={`${inputId}-help`}
              aria-label="Tip amount in rupees"
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              className="pl-7"
            />
          </div>
          <Button type="submit" variant="secondary">Add tip</Button>
          <Button type="button" variant="ghost" onClick={() => { setOther(false); setError(null); }}>Cancel</Button>
          <p id={`${inputId}-help`} className={clsx("basis-full text-sm", error ? "text-vermilion" : "text-xs text-ink-faint")}>
            {error ?? `Up to ${rupees(max)}`}
          </p>
        </form>
      )}
      {tip > 0 && !other && (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-leaf">
          <HandHeart className="h-4 w-4" aria-hidden /> Thank you! Your {rupees(tip)} tip is added to the bill.
        </p>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- GSTIN for a business purchase */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export type BusinessErrors = { gstin?: string; business?: string };

/** Problems with the GSTIN and business name. Nothing is checked while the GSTIN is empty (not a business purchase). */
export function businessErrors(gstin: string, business: string): BusinessErrors {
  const g = gstin.trim();
  if (!g) return {};
  const out: BusinessErrors = {};
  if (g.length !== 15) out.gstin = "A GSTIN has 15 characters";
  else if (!GSTIN_RE.test(g)) out.gstin = "This GSTIN does not look right. Check it against your GST certificate";
  const b = business.trim();
  if (!b) out.business = "Enter the business name registered for this GSTIN";
  else if (b.length < 2) out.business = "Enter the full business name";
  return out;
}

export function BusinessSection({ gstin, business, onGstin, onBusiness, open, onOpen, showErrors, serverError }: {
  gstin: string; business: string; onGstin: (v: string) => void; onBusiness: (v: string) => void;
  open: boolean; onOpen: (open: boolean) => void; showErrors: boolean; serverError: string | null;
}) {
  const [touched, setTouched] = useState({ gstin: false, business: false });
  const errors = businessErrors(gstin, business);
  const filled = gstin.trim() !== "";
  const valid = filled && !errors.gstin && !errors.business;
  const gstinError = serverError ?? ((touched.gstin || showErrors) ? errors.gstin : undefined);
  const businessError = (touched.business || showErrors) ? errors.business : undefined;

  return (
    <section id="checkout-business" aria-labelledby="co-gst-h" data-testid="checkout-gstin" className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
      <h2 id="co-gst-h" className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="co-gst-panel"
          onClick={() => onOpen(!open)}
          className="flex w-full items-center gap-3 rounded-xl text-left"
        >
          <IconBadge icon={Building2} />
          <span className="min-w-0 flex-1">
            <span className="block font-display text-lg font-semibold leading-tight text-ink">Add GSTIN for a business purchase</span>
            <span className="mt-0.5 block font-sans text-sm font-normal leading-snug text-ink-soft">Claim GST credit on the tax invoice.</span>
          </span>
          <ChevronDown className={clsx("h-5 w-5 shrink-0 text-ink-soft transition-transform", open && "rotate-180")} aria-hidden />
        </button>
      </h2>
      {!open && filled && (
        <p className={clsx("mt-3 flex items-center gap-1.5 text-sm font-semibold", valid ? "text-leaf" : "text-vermilion")}>
          {valid ? <CircleCheck className="h-4 w-4 shrink-0" aria-hidden /> : null}
          {valid ? `GSTIN ${gstin} · ${business.trim()}` : "Check the GSTIN details before you pay"}
        </p>
      )}
      {open && (
        <div id="co-gst-panel" className="mt-4 grid gap-3 sm:grid-cols-2">
          <TextField
            label="GSTIN"
            value={gstin}
            onChange={(e) => onGstin(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15))}
            onBlur={() => setTouched((t) => ({ ...t, gstin: true }))}
            maxLength={15}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="22AAAAA0000A1Z5"
            error={gstinError}
          />
          <TextField
            label="Business name"
            value={business}
            onChange={(e) => onBusiness(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, business: true }))}
            maxLength={160}
            autoComplete="organization"
            placeholder="As registered for GST"
            error={businessError}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <p className="text-xs text-ink-faint">Each seller prints these on their tax invoice. Check they match your GST registration.</p>
            {filled && (
              <button
                type="button"
                onClick={() => {
                  onGstin("");
                  onBusiness("");
                  setTouched({ gstin: false, business: false });
                }}
                className="text-sm font-semibold text-vermilion hover:underline"
              >
                Remove GSTIN
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- no bag */

export function NoBagSection({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label
      data-testid="checkout-no-bag"
      className="flex cursor-pointer items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5"
    >
      <IconBadge icon={Leaf} tone="leaf" />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-ink">I don&apos;t need a bag</span>
        <span className="block text-sm text-ink-soft">Take the pledge for a greener future</span>
      </span>
      <input type="checkbox" role="switch" className="peer sr-only" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={clsx(
          "relative h-7 w-12 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-leaf",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-peacock peer-focus-visible:ring-offset-2",
          "after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5",
        )}
      />
    </label>
  );
}

/* ---------------------------------------------------------------- gift message */

export function GiftMessageSection({ text, onText, max }: { text: string; onText: (text: string) => void; max: number }) {
  const id = useId();
  return (
    <Card labelledBy="co-gift-h" testId="checkout-gift">
      <CardHeading id="co-gift-h" icon={Gift} title="Gift message" sub="The seller packs it with your order. The price is not shown." />
      <label htmlFor={id} className="sr-only">Gift message</label>
      <Textarea id={id} value={text} maxLength={max} rows={3} onChange={(e) => onText(e.target.value)} placeholder="E.g. Happy birthday! Hope you like it." />
      <p className="mt-1 text-right text-xs text-ink-soft" aria-live="polite">{text.length}/{max}</p>
    </Card>
  );
}
