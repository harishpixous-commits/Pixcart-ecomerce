/**
 * FR-LOG-006 warehouse operations. The suite is built around the scan-match gate at pack, because
 * a pack step that merely "checks" and then packs anyway is how a customer receives the wrong item
 * — and the platform then owns both the return freight and the review.
 */
import { describe, expect, it } from 'vitest';
import {
  COUNT_VARIANCE_RECOUNT_THRESHOLD,
  GRN_VARIANCE_TOLERANCE,
  Warehouse,
  type Consignment,
  type OrderLine,
} from '../src/domain/warehouse.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const consignment = (over: Partial<Consignment> = {}): Consignment => ({
  consignmentId: 'CON-1',
  vendorId: 'V1',
  lines: [{ sku: 'SAREE-A', declaredUnits: 100 }, { sku: 'SAREE-B', declaredUnits: 50 }],
  ...over,
});

/** A warehouse with barcodes registered and stock put away. */
const stocked = () => {
  const w = new Warehouse();
  w.registerSkuBarcode('SAREE-A', '8901234567890');
  w.registerSkuBarcode('SAREE-B', '8901234567891');
  w.putaway('BIN-A1', 'SAREE-A', 60);
  w.putaway('BIN-A2', 'SAREE-A', 40);
  w.putaway('BIN-B1', 'SAREE-B', 50);
  return w;
};

// ============================================ scan-match at pack

describe('scan-match is enforced at pack (VALIDATION)', () => {
  const lines: OrderLine[] = [
    { lineId: 'L1', sku: 'SAREE-A', qty: 1 },
    { lineId: 'L2', sku: 'SAREE-B', qty: 2 },
  ];

  it('packs only when every line is matched by the correct barcode', () => {
    const w = stocked();
    const r = w.pack('SHP-1', lines, [
      { lineId: 'L1', scannedBarcode: '8901234567890' },
      { lineId: 'L2', scannedBarcode: '8901234567891' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verifiedLineIds).toEqual(['L1', 'L2']);
  });

  it('refuses when a line was never scanned — the shipment does not exist until it verifies', () => {
    const w = stocked();
    const r = w.pack('SHP-1', lines, [{ lineId: 'L1', scannedBarcode: '8901234567890' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('SCAN_MATCH_FAILED');
      expect(r.unmatchedLineIds).toEqual(['L2']);
    }
  });

  it('refuses when a scanned barcode belongs to a DIFFERENT product', () => {
    const w = stocked();
    // the packer picked up SAREE-B for line L1 — the exact error the gate exists to catch
    const r = w.pack('SHP-1', lines, [
      { lineId: 'L1', scannedBarcode: '8901234567891' },
      { lineId: 'L2', scannedBarcode: '8901234567891' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unmatchedLineIds).toEqual(['L1']);
  });

  it('refuses an unregistered SKU rather than accepting any barcode for it', () => {
    const w = new Warehouse();      // no barcodes registered
    const r = w.pack('SHP-1', [{ lineId: 'L1', sku: 'UNKNOWN', qty: 1 }],
      [{ lineId: 'L1', scannedBarcode: 'anything' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unmatchedLineIds).toEqual(['L1']);
  });

  it('refuses a scan for a line that is not on the order', () => {
    const w = stocked();
    const r = w.pack('SHP-1', lines, [
      { lineId: 'L1', scannedBarcode: '8901234567890' },
      { lineId: 'L2', scannedBarcode: '8901234567891' },
      { lineId: 'L9', scannedBarcode: '8901234567890' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('SCAN_FOR_LINE_NOT_ON_ORDER');
  });

  it('refuses an empty pack rather than producing a shipment of nothing', () => {
    const r = stocked().pack('SHP-1', [], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOTHING_TO_PACK');
  });

  it('reports every unmatched line at once, not one per attempt', () => {
    const w = stocked();
    const r = w.pack('SHP-1', lines, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unmatchedLineIds).toEqual(['L1', 'L2']);
  });
});

// ============================================ GRN

describe('GRN variance beyond tolerance holds the consignment (VALIDATION)', () => {
  it('accepts a delivery within tolerance', () => {
    const w = new Warehouse();
    const r = w.receive(consignment(), [
      { sku: 'SAREE-A', receivedUnits: 99 },     // 1% short
      { sku: 'SAREE-B', receivedUnits: 50 },
    ]);
    expect(r.status).toBe('ACCEPTED');
    expect(r.vendorNotice).toBeUndefined();
    expect(r.variances.every((v) => !v.beyondTolerance)).toBe(true);
  });

  it('holds a short delivery beyond tolerance and issues a vendor notice', () => {
    const w = new Warehouse();
    const r = w.receive(consignment(), [
      { sku: 'SAREE-A', receivedUnits: 90 },     // 10% short
      { sku: 'SAREE-B', receivedUnits: 50 },
    ]);
    expect(r.status).toBe('HELD_VARIANCE');
    expect(r.vendorNotice).toContain('CON-1');
    expect(r.vendorNotice).toContain('SAREE-A declared 100 received 90');
    const offender = r.variances.find((v) => v.sku === 'SAREE-A')!;
    expect(offender.varianceUnits).toBe(-10);
    expect(offender.varianceRatio).toBeCloseTo(0.1, 4);
    expect(offender.beyondTolerance).toBe(true);
  });

  it('holds an OVER-delivery too, since unexpected stock is also a discrepancy', () => {
    const w = new Warehouse();
    const r = w.receive(consignment(), [
      { sku: 'SAREE-A', receivedUnits: 130 },
      { sku: 'SAREE-B', receivedUnits: 50 },
    ]);
    expect(r.status).toBe('HELD_VARIANCE');
    expect(r.variances.find((v) => v.sku === 'SAREE-A')!.varianceUnits).toBe(30);
  });

  it('holds when a SKU nobody declared turns up in the box', () => {
    const w = new Warehouse();
    const r = w.receive(consignment(), [
      { sku: 'SAREE-A', receivedUnits: 100 },
      { sku: 'SAREE-B', receivedUnits: 50 },
      { sku: 'SAREE-MYSTERY', receivedUnits: 5 },
    ]);
    expect(r.status).toBe('HELD_VARIANCE');
    const mystery = r.variances.find((v) => v.sku === 'SAREE-MYSTERY')!;
    expect(mystery.declaredUnits).toBe(0);
    expect(mystery.beyondTolerance).toBe(true);
  });

  it('a wholly missing line is a 100% variance and holds', () => {
    const w = new Warehouse();
    const r = w.receive(consignment(), [{ sku: 'SAREE-A', receivedUnits: 100 }]);
    expect(r.status).toBe('HELD_VARIANCE');
    expect(r.variances.find((v) => v.sku === 'SAREE-B')!.receivedUnits).toBe(0);
  });

  it('the tolerance boundary is exact', () => {
    const w = new Warehouse();
    const atTolerance = w.receive(
      consignment({ lines: [{ sku: 'SAREE-A', declaredUnits: 100 }] }),
      [{ sku: 'SAREE-A', receivedUnits: 98 }]);       // exactly 2%
    expect(atTolerance.status).toBe('ACCEPTED');
    expect(GRN_VARIANCE_TOLERANCE).toBe(0.02);

    const beyond = w.receive(
      consignment({ lines: [{ sku: 'SAREE-A', declaredUnits: 100 }] }),
      [{ sku: 'SAREE-A', receivedUnits: 97 }]);
    expect(beyond.status).toBe('HELD_VARIANCE');
  });
});

// ============================================ putaway

describe('putaway keeps bins single-SKU and single-expiry', () => {
  it('accumulates units into a bin and reports on-hand across bins', () => {
    const w = stocked();
    expect(w.bin('BIN-A1')!.units).toBe(60);
    expect(w.onHand('SAREE-A')).toBe(100);
    w.putaway('BIN-A1', 'SAREE-A', 10);
    expect(w.bin('BIN-A1')!.units).toBe(70);
    expect(w.onHand('SAREE-A')).toBe(110);
  });

  it('refuses to mix SKUs in one bin', () => {
    const w = stocked();
    const r = w.putaway('BIN-A1', 'SAREE-B', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('BIN_HOLDS_A_DIFFERENT_SKU');
  });

  it('refuses to mix expiry dates, because that defeats FEFO', () => {
    const w = new Warehouse();
    w.putaway('BIN-D1', 'MILK', 10, NOW + 10 * DAY);
    const r = w.putaway('BIN-D1', 'MILK', 10, NOW + 20 * DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BIN_HOLDS_A_DIFFERENT_EXPIRY_DATE');
  });

  it('refuses a non-positive putaway', () => {
    expect(stocked().putaway('BIN-A1', 'SAREE-A', 0).ok).toBe(false);
    expect(stocked().putaway('BIN-A1', 'SAREE-A', -5).ok).toBe(false);
  });

  it('empty bins are excluded from bin-accurate inventory', () => {
    const w = new Warehouse();
    w.putaway('BIN-X', 'SAREE-A', 5);
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'SAREE-A', qty: 5 }]).tasks[0];
    w.confirmPick(task, 'BIN-X');
    expect(w.onHand('SAREE-A')).toBe(0);
    expect(w.binsFor('SAREE-A')).toEqual([]);
  });
});

// ============================================ wave picking & FEFO

describe('wave picking directs to a bin, FEFO for dated goods (RULES)', () => {
  it('builds tasks and reports unfulfillable lines rather than silently dropping them', () => {
    const w = stocked();
    const wave = w.buildWave('W1', [
      { lineId: 'L1', sku: 'SAREE-A', qty: 10 },
      { lineId: 'L2', sku: 'SAREE-NONE', qty: 1 },
    ]);
    expect(wave.tasks).toHaveLength(1);
    expect(wave.tasks[0].lineId).toBe('L1');
    expect(wave.unfulfillable).toEqual(['L2']);
  });

  it('directs a dated pick to the EARLIEST-expiring bin', () => {
    const w = new Warehouse();
    w.putaway('BIN-LATE', 'MILK', 20, NOW + 30 * DAY);
    w.putaway('BIN-SOON', 'MILK', 20, NOW + 5 * DAY);
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'MILK', qty: 10 }]).tasks[0];
    expect(task.binId).toBe('BIN-SOON');
    expect(task.expiryMs).toBe(NOW + 5 * DAY);
  });

  it('raises a FEFO violation if a later-expiring bin is picked while an earlier one has stock', () => {
    const w = new Warehouse();
    w.putaway('BIN-LATE', 'MILK', 20, NOW + 30 * DAY);
    w.putaway('BIN-SOON', 'MILK', 20, NOW + 5 * DAY);
    // a picker takes from the convenient bin instead of the directed one
    const wrongTask = { taskId: 'T1', lineId: 'L1', sku: 'MILK', qty: 10, binId: 'BIN-LATE', expiryMs: NOW + 30 * DAY };
    const r = w.confirmPick(wrongTask, 'BIN-LATE');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('FEFO_VIOLATION');
      expect(r.reallocatedBinId).toBe('BIN-SOON');
    }
  });

  it('picking the earliest-expiring bin succeeds and decrements it', () => {
    const w = new Warehouse();
    w.putaway('BIN-SOON', 'MILK', 20, NOW + 5 * DAY);
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'MILK', qty: 10 }]).tasks[0];
    expect(w.confirmPick(task, 'BIN-SOON').ok).toBe(true);
    expect(w.bin('BIN-SOON')!.units).toBe(10);
  });

  it('undated stock consolidates from the fullest bin', () => {
    const w = stocked();
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'SAREE-A', qty: 10 }]).tasks[0];
    expect(task.binId).toBe('BIN-A1');    // 60 units, versus 40 in BIN-A2
  });

  it('a bin without enough stock for the whole line is not chosen', () => {
    const w = new Warehouse();
    w.putaway('BIN-SMALL', 'SAREE-A', 3);
    w.putaway('BIN-BIG', 'SAREE-A', 30);
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'SAREE-A', qty: 10 }]).tasks[0];
    expect(task.binId).toBe('BIN-BIG');
  });
});

describe('a bin mismatch at pick raises an exception and re-allocates (ERRORS)', () => {
  it('refuses the pick, flags an exception task and names an alternate bin', () => {
    const w = stocked();
    const task = w.buildWave('W1', [{ lineId: 'L1', sku: 'SAREE-A', qty: 10 }]).tasks[0];
    const r = w.confirmPick(task, 'BIN-WRONG');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('BIN_MISMATCH');
      expect(r.exceptionTask).toBe(true);
      expect(r.reallocatedBinId).toBeDefined();
    }
    // and inventory is untouched, so bin accuracy survives the mistake
    expect(w.onHand('SAREE-A')).toBe(100);
  });

  it('a short bin at pick raises an exception rather than going negative', () => {
    const w = new Warehouse();
    w.putaway('BIN-X', 'SAREE-A', 5);
    const task = { taskId: 'T1', lineId: 'L1', sku: 'SAREE-A', qty: 10, binId: 'BIN-X' };
    const r = w.confirmPick(task, 'BIN-X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BIN_SHORT_AT_PICK');
    expect(w.bin('BIN-X')!.units).toBe(5);
  });
});

// ============================================ cycle counts

describe('cycle counts trigger a recount beyond 0.5% variance (RULES)', () => {
  const task = { taskId: 'CT-1', binId: 'BIN-A1', sku: 'SAREE-A', systemUnits: 1000 };

  it('a variance within tolerance needs no recount', () => {
    const w = stocked();
    const r = w.count(task, 997);          // 0.3%
    expect(r.varianceUnits).toBe(-3);
    expect(r.recountRequired).toBe(false);
    expect(r.investigationRequired).toBe(false);
  });

  it('a variance beyond 0.5% triggers a recount AND an investigation', () => {
    const w = stocked();
    const r = w.count(task, 990);          // 1%
    expect(r.varianceRatio).toBeCloseTo(0.01, 5);
    expect(r.recountRequired).toBe(true);
    expect(r.investigationRequired).toBe(true);
  });

  it('the threshold boundary is exact', () => {
    const w = stocked();
    expect(w.count(task, 995).recountRequired).toBe(false);    // exactly 0.5%
    expect(w.count(task, 994).recountRequired).toBe(true);
    expect(COUNT_VARIANCE_RECOUNT_THRESHOLD).toBe(0.005);
  });

  it('an overage is as much a variance as a shortage', () => {
    const w = stocked();
    const r = w.count(task, 1020);
    expect(r.varianceUnits).toBe(20);
    expect(r.recountRequired).toBe(true);
  });

  it('a bin the system believes empty but which holds stock is a full variance', () => {
    const w = stocked();
    const r = w.count({ taskId: 'CT-2', binId: 'BIN-E', sku: 'SAREE-A', systemUnits: 0 }, 7);
    expect(r.varianceRatio).toBe(1);
    expect(r.recountRequired).toBe(true);
  });

  it('applying a settled count corrects the bin', () => {
    const w = stocked();
    expect(w.applyCount('BIN-A1', 58).ok).toBe(true);
    expect(w.bin('BIN-A1')!.units).toBe(58);
    expect(w.applyCount('BIN-NONE', 5).ok).toBe(false);
    expect(w.applyCount('BIN-A1', -1).ok).toBe(false);
  });
});

// ============================================ storage fees

describe('storage fees accrue to vendor settlement (RULES)', () => {
  it('produces an accrual for finance to post rather than writing a ledger entry here', () => {
    const a = Warehouse.accrueStorage('V1', 120, 250);
    expect(a.vendorId).toBe('V1');
    expect(a.binDays).toBe(120);
    expect(a.amountPaise).toBe(30_000);
    expect(a.feeType).toBe('STORAGE');
  });

  it('rounds to whole paise', () => {
    expect(Warehouse.accrueStorage('V1', 3, 33.4).amountPaise).toBe(100);
  });

  it('zero bin-days accrues nothing', () => {
    expect(Warehouse.accrueStorage('V1', 0, 250).amountPaise).toBe(0);
  });
});
