/**
 * FR-FIN-002 tax engine acceptance & validation as tests. Traceability: FR-FIN-002
 * (HSN resolution, CGST/SGST vs IGST, inclusive back-calc, effective-dating), BRU-04.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLineTax,
  reconcile,
  resolveRate,
  taxFromInclusive,
  type HsnRate,
  type TaxLineInput,
} from '../src/domain/tax.js';

const schedule: HsnRate[] = [
  { hsn: '6109', rateBps: 1800, effectiveFrom: '2025-01-01', effectiveTo: '2026-07-01' },
  { hsn: '6109', rateBps: 1200, effectiveFrom: '2026-07-01' }, // rate cut, effective-dated
  { hsn: '5007', rateBps: 500, effectiveFrom: '2025-01-01' },
];

const line = (over: Partial<TaxLineInput> = {}): TaxLineInput => ({
  lineId: 'L1',
  hsn: '6109',
  inclusivePaise: 1_18_000, // ₹1180 inclusive
  vendorStateCode: 'TN',
  shipToStateCode: 'KA',
  vendorRegistered: true,
  ...over,
});

const okLine = (r: ReturnType<typeof computeLineTax>) => {
  if (!r.ok) throw new Error('expected ok tax, got ' + r.reason);
  return r.line;
};

describe('FR-FIN-002 tax engine', () => {
  it('the acceptance scenario: TN vendor, KA ship-to, 18% → IGST with taxable = price×100/118', () => {
    // Use the pre-cut window so the rate is 18%.
    const l = okLine(computeLineTax(line(), schedule, '2026-06-15'));
    expect(l.kind).toBe('IGST');
    expect(l.rateBps).toBe(1800);
    // 118000 × 100/118 = 100000 exactly
    expect(l.taxablePaise).toBe(1_00_000);
    expect(l.igstPaise).toBe(18_000);
    expect(l.cgstPaise).toBe(0);
    expect(l.sgstPaise).toBe(0);
    // reconciles to the paisa
    expect(l.taxablePaise + l.totalTaxPaise).toBe(l.inclusivePaise);
  });

  it('intra-state (TN→TN) splits into CGST + SGST that sum back to the total tax', () => {
    const l = okLine(computeLineTax(line({ shipToStateCode: 'TN' }), schedule, '2026-06-15'));
    expect(l.kind).toBe('CGST_SGST');
    expect(l.cgstPaise + l.sgstPaise).toBe(l.totalTaxPaise);
    expect(l.igstPaise).toBe(0);
    // 18000 splits 9000/9000
    expect(l.cgstPaise).toBe(9_000);
    expect(l.sgstPaise).toBe(9_000);
  });

  it('odd-paisa tax gives the extra paisa to CGST so halves still sum exactly', () => {
    // choose an inclusive amount whose tax is odd in paise
    const l = okLine(computeLineTax(
      line({ shipToStateCode: 'TN', inclusivePaise: 1_18_001 }), schedule, '2026-06-15'));
    expect(l.cgstPaise + l.sgstPaise).toBe(l.totalTaxPaise);
    expect(Math.abs(l.cgstPaise - l.sgstPaise)).toBeLessThanOrEqual(1);
  });

  it('inclusive back-calc: taxable + tax always equals the inclusive price (property)', () => {
    for (const inc of [1, 99, 100, 118, 1180, 15_00_099, 7_77_777]) {
      for (const rate of [500, 1200, 1800, 2800]) {
        const { taxablePaise, taxPaise } = taxFromInclusive(inc, rate);
        expect(taxablePaise + taxPaise).toBe(inc);
      }
    }
  });

  it('effective-dating: the same HSN resolves to different rates before/after the cut', () => {
    expect(resolveRate(schedule, '6109', '2026-06-30')).toEqual({ ok: true, rateBps: 1800 });
    expect(resolveRate(schedule, '6109', '2026-07-01')).toEqual({ ok: true, rateBps: 1200 });
  });

  it('an HSN with no active rate on the order date is rejected (VALIDATION)', () => {
    const r = computeLineTax(line({ hsn: '9999' }), schedule, '2026-06-15');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('NO_ACTIVE_HSN_RATE');
  });

  it('an HSN resolving to two active rates is rejected as ambiguous (VALIDATION)', () => {
    const overlapping: HsnRate[] = [
      { hsn: '6109', rateBps: 1800, effectiveFrom: '2025-01-01' },
      { hsn: '6109', rateBps: 1200, effectiveFrom: '2025-06-01' }, // both open-ended → overlap
    ];
    const r = computeLineTax(line(), overlapping, '2026-06-15');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('AMBIGUOUS_HSN_RATE');
  });

  it('unregistered vendor takes the exempt path (zero tax) unless the category guards it', () => {
    const exempt = okLine(computeLineTax(line({ vendorRegistered: false }), schedule, '2026-06-15'));
    expect(exempt.kind).toBe('EXEMPT');
    expect(exempt.totalTaxPaise).toBe(0);
    expect(exempt.taxablePaise).toBe(exempt.inclusivePaise);

    const guarded = computeLineTax(
      line({ vendorRegistered: false, categoryAllowsExempt: false }), schedule, '2026-06-15');
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.reason).toBe('UNREGISTERED_VENDOR_IN_GUARDED_CATEGORY');
  });

  it('reconcile() passes for a mixed invoice', () => {
    const a = okLine(computeLineTax(line(), schedule, '2026-06-15'));
    const b = okLine(computeLineTax(line({ lineId: 'L2', shipToStateCode: 'TN' }), schedule, '2026-06-15'));
    const c = okLine(computeLineTax(line({ lineId: 'L3', hsn: '5007' }), schedule, '2026-06-15'));
    expect(reconcile([a, b, c])).toBe(true);
  });
});
