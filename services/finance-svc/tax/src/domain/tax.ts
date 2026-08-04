/**
 * Tax Engine (GST/VAT) — FR-FIN-002.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:        "tax per line using HSN-rate mapping, vendor GST registration state vs
 *                 ship-to state (CGST+SGST vs IGST), inclusive-price back-calculation, and
 *                 a VAT mode for future non-India regions via configuration."
 *   RULES:       BRU-04 inclusive display; rate changes effective-dated (no retro mutation
 *                 — corrections via credit/debit notes only).
 *   ACCEPTANCE:  "vendor-state TN and ship-to KA at 18% → IGST 18% shows with taxable
 *                 value = price×100/118 rounded per rules, and totals reconcile to the paisa."
 *   VALIDATION:  "HSN must resolve to exactly one active rate on order date;
 *                 unregistered-vendor lines flagged tax-exempt path with category guard."
 *   BRU-04:      "Prices displayed are GST-inclusive; invoice shows tax break-up per line."
 *
 * Pure and deterministic. Money is integer paise; each line's tax is rounded half-up
 * (CBIC rule). Intra-state splits CGST/SGST from the single rounded tax so the two halves
 * always sum back to it exactly (no double-rounding). Rate schedules are effective-dated
 * and immutable: a lookup is always "as of order date", so historical invoices never move.
 */
import { fromPaise, halfUpDiv, Paise } from './money.js';

/** An effective-dated HSN→rate entry. rateBps is basis points (1800 = 18%). */
export interface HsnRate {
  hsn: string;
  rateBps: number;
  effectiveFrom: string; // ISO date inclusive
  effectiveTo?: string;  // ISO date exclusive; open-ended if omitted
}

export type TaxKind = 'CGST_SGST' | 'IGST' | 'EXEMPT';

export interface TaxLineInput {
  lineId: string;
  hsn: string;
  /** GST-inclusive price actually charged for the line, in paise (BRU-04). */
  inclusivePaise: Paise;
  vendorStateCode: string;   // e.g. "TN"
  shipToStateCode: string;   // e.g. "KA"
  vendorRegistered: boolean; // unregistered → exempt path (validation)
  /** Category guard: some categories may not use the exempt path even if unregistered. */
  categoryAllowsExempt?: boolean;
}

export interface TaxLineResult {
  lineId: string;
  kind: TaxKind;
  rateBps: number;
  taxablePaise: Paise;   // back-calculated from the inclusive price
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  totalTaxPaise: Paise;  // cgst+sgst OR igst
  inclusivePaise: Paise; // == taxable + totalTax, reconciled to the paisa
}

export type TaxResult =
  | { ok: true; line: TaxLineResult }
  | { ok: false; reason: string };

/** Resolve exactly one active rate for an HSN as of the order date (VALIDATION). */
export function resolveRate(schedule: HsnRate[], hsn: string, orderDateIso: string):
  { ok: true; rateBps: number } | { ok: false; reason: string } {
  const d = Date.parse(orderDateIso);
  const active = schedule.filter(
    (r) =>
      r.hsn === hsn &&
      Date.parse(r.effectiveFrom) <= d &&
      (r.effectiveTo === undefined || d < Date.parse(r.effectiveTo)),
  );
  if (active.length === 0) return { ok: false, reason: `NO_ACTIVE_HSN_RATE for ${hsn} on ${orderDateIso}` };
  if (active.length > 1) return { ok: false, reason: `AMBIGUOUS_HSN_RATE for ${hsn}: ${active.length} active` };
  return { ok: true, rateBps: active[0].rateBps };
}

/**
 * Back-calculate tax from a GST-inclusive price (BRU-04). For an inclusive amount I at
 * rate r (bps), taxable = round(I × 10000 / (10000 + r)); tax = I − taxable. Because tax
 * is the remainder, taxable + tax == inclusive exactly, always.
 */
export function taxFromInclusive(inclusivePaise: Paise, rateBps: number): { taxablePaise: Paise; taxPaise: Paise } {
  const taxable = halfUpDiv(inclusivePaise * 10_000, 10_000 + rateBps);
  return { taxablePaise: taxable, taxPaise: inclusivePaise - taxable };
}

export function computeLineTax(input: TaxLineInput, schedule: HsnRate[], orderDateIso: string): TaxResult {
  // Unregistered vendor → exempt path, but only where the category permits it.
  if (!input.vendorRegistered) {
    if (input.categoryAllowsExempt === false) {
      return { ok: false, reason: 'UNREGISTERED_VENDOR_IN_GUARDED_CATEGORY' };
    }
    return {
      ok: true,
      line: {
        lineId: input.lineId, kind: 'EXEMPT', rateBps: 0,
        taxablePaise: input.inclusivePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0,
        totalTaxPaise: 0, inclusivePaise: input.inclusivePaise,
      },
    };
  }

  const rate = resolveRate(schedule, input.hsn, orderDateIso);
  if (!rate.ok) return { ok: false, reason: rate.reason };

  const { taxablePaise, taxPaise } = taxFromInclusive(input.inclusivePaise, rate.rateBps);
  const intraState = input.vendorStateCode === input.shipToStateCode;

  if (intraState) {
    // CGST/SGST each = half the rounded total tax; give any odd paisa to CGST so the two
    // halves sum back to totalTax exactly (no independent rounding of each half).
    const cgst = halfUpDiv(taxPaise, 2);
    const sgst = taxPaise - cgst;
    return {
      ok: true,
      line: {
        lineId: input.lineId, kind: 'CGST_SGST', rateBps: rate.rateBps,
        taxablePaise, cgstPaise: cgst, sgstPaise: sgst, igstPaise: 0,
        totalTaxPaise: taxPaise, inclusivePaise: input.inclusivePaise,
      },
    };
  }

  return {
    ok: true,
    line: {
      lineId: input.lineId, kind: 'IGST', rateBps: rate.rateBps,
      taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise,
      totalTaxPaise: taxPaise, inclusivePaise: input.inclusivePaise,
    },
  };
}

/** Invoice-level reconciliation: every line's taxable+tax must equal its inclusive. */
export function reconcile(lines: TaxLineResult[]): boolean {
  return lines.every((l) => l.taxablePaise + l.totalTaxPaise === l.inclusivePaise
    && l.cgstPaise + l.sgstPaise + l.igstPaise === l.totalTaxPaise);
}

/** Human-readable one-line summary for a credit/debit note or invoice row. */
export function describe(l: TaxLineResult): string {
  const parts = l.kind === 'CGST_SGST'
    ? `CGST ${fromPaise(l.cgstPaise)} + SGST ${fromPaise(l.sgstPaise)}`
    : l.kind === 'IGST' ? `IGST ${fromPaise(l.igstPaise)}` : 'EXEMPT';
  return `${l.lineId}: taxable ${fromPaise(l.taxablePaise)}, ${parts} (rate ${l.rateBps / 100}%)`;
}
