/**
 * Warehouse operations (operator fulfilment) — FR-LOG-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "support operator-run warehouses: GRN inbound against vendor consignments,
 *                putaway with bin locations, wave picking, pack verification (scan-match), and
 *                cycle counts, for vendors opting into platform fulfilment."
 *   INPUTS:     "ASN/consignment declarations, barcode scans (GRN, putaway, pick, pack), count
 *                tasks."
 *   OUTPUTS:    "Bin-accurate inventory (feeds FR-VEN-004 as location), pick lists/waves,
 *                pack-verified shipments, count variance reports."
 *   VALIDATION: "Scan-match enforced at pack (item barcode ↔ order line); GRN variance beyond
 *                tolerance → hold + vendor notice."
 *   RULES:      "Storage fees accrue to vendor settlement (FR-FIN-001 fee type); FEFO for dated
 *                goods; count variance > 0.5% triggers recount + investigation."
 *   ERRORS:     "Bin mismatch at pick → exception task, order re-allocated from alternate bin."
 *
 * The scan-match gate at pack is the requirement's real substance, and it is enforced as a
 * precondition rather than a verification step: a shipment cannot reach a packed state without
 * every order line having been matched by a scan of the item actually in the box. A pack step that
 * merely "checks" and then packs anyway is how a customer receives the wrong saree, and the
 * platform then owns both the return freight and the review.
 *
 * FEFO is likewise not advisory. For dated goods the picker is directed to the earliest-expiring
 * bin, and picking a later-expiring unit while an earlier one is available raises an exception —
 * otherwise stock quietly ages into write-off at the back of a bin.
 */

/** VALIDATION: GRN quantity variance tolerated before the consignment is held. */
export const GRN_VARIANCE_TOLERANCE = 0.02;      // 2% of declared units
/** RULES: cycle-count variance beyond this triggers a recount and investigation. */
export const COUNT_VARIANCE_RECOUNT_THRESHOLD = 0.005;   // 0.5%

export interface ConsignmentLine {
  sku: string;
  declaredUnits: number;
  /** Expiry for dated goods, driving FEFO. */
  expiryMs?: number;
}

export interface Consignment {
  consignmentId: string;
  vendorId: string;
  lines: ConsignmentLine[];
}

export interface ReceivedLine {
  sku: string;
  receivedUnits: number;
  expiryMs?: number;
}

export type GrnStatus = 'ACCEPTED' | 'HELD_VARIANCE';

export interface GrnVariance {
  sku: string;
  declaredUnits: number;
  receivedUnits: number;
  varianceUnits: number;
  varianceRatio: number;
  beyondTolerance: boolean;
}

export interface GrnResult {
  consignmentId: string;
  status: GrnStatus;
  variances: GrnVariance[];
  /** VALIDATION: a hold carries a vendor notice. */
  vendorNotice?: string;
}

/** A bin holding units of one SKU, optionally dated. */
export interface Bin {
  binId: string;
  sku: string;
  units: number;
  expiryMs?: number;
}

export type PutawayResult =
  | { ok: true; binId: string; units: number }
  | { ok: false; reason: string };

export interface OrderLine {
  lineId: string;
  sku: string;
  qty: number;
}

export interface PickTask {
  taskId: string;
  lineId: string;
  sku: string;
  qty: number;
  /** The bin the picker is directed to — FEFO for dated goods. */
  binId: string;
  expiryMs?: number;
}

export type PickResult =
  | { ok: true; task: PickTask }
  /** ERRORS: a bin mismatch raises an exception task and re-allocates from an alternate bin. */
  | { ok: false; reason: string; exceptionTask: true; reallocatedBinId?: string };

export interface ScanMatch {
  lineId: string;
  scannedBarcode: string;
}

export type PackResult =
  | { ok: true; shipmentId: string; verifiedLineIds: string[] }
  | { ok: false; reason: string; unmatchedLineIds: string[] };

export interface CountTask {
  taskId: string;
  binId: string;
  sku: string;
  systemUnits: number;
}

export interface CountResult {
  taskId: string;
  binId: string;
  sku: string;
  systemUnits: number;
  countedUnits: number;
  varianceUnits: number;
  varianceRatio: number;
  /** RULES: variance beyond 0.5% triggers a recount and an investigation. */
  recountRequired: boolean;
  investigationRequired: boolean;
}

/** RULES: storage fees accrue to vendor settlement as an FR-FIN-001 fee type. */
export interface StorageAccrual {
  vendorId: string;
  binDays: number;
  ratePaisePerBinDay: number;
  amountPaise: number;
  feeType: 'STORAGE';
}

export class Warehouse {
  private readonly bins = new Map<string, Bin>();
  /** SKU -> the barcode the item actually carries, from the catalogue. */
  private readonly skuBarcodes = new Map<string, string>();

  registerSkuBarcode(sku: string, barcode: string): void {
    this.skuBarcodes.set(sku, barcode);
  }

  // ------------------------------------------------------------- GRN

  /**
   * VALIDATION: receive a consignment. Variance beyond tolerance holds the consignment and issues
   * a vendor notice rather than silently accepting a short delivery — accepting one would put
   * stock the warehouse does not hold onto a live listing.
   */
  receive(consignment: Consignment, received: ReceivedLine[]): GrnResult {
    const receivedBySku = new Map(received.map((r) => [r.sku, r]));
    const variances: GrnVariance[] = [];

    for (const line of consignment.lines) {
      const got = receivedBySku.get(line.sku)?.receivedUnits ?? 0;
      const varianceUnits = got - line.declaredUnits;
      const ratio = line.declaredUnits === 0
        ? (got === 0 ? 0 : 1)
        : Math.abs(varianceUnits) / line.declaredUnits;
      variances.push({
        sku: line.sku,
        declaredUnits: line.declaredUnits,
        receivedUnits: got,
        varianceUnits,
        varianceRatio: Math.round(ratio * 10_000) / 10_000,
        beyondTolerance: ratio > GRN_VARIANCE_TOLERANCE,
      });
    }

    // an undeclared SKU in the box is itself a variance worth holding for
    for (const r of received) {
      if (!consignment.lines.some((l) => l.sku === r.sku)) {
        variances.push({
          sku: r.sku,
          declaredUnits: 0,
          receivedUnits: r.receivedUnits,
          varianceUnits: r.receivedUnits,
          varianceRatio: 1,
          beyondTolerance: true,
        });
      }
    }

    const offenders = variances.filter((v) => v.beyondTolerance);
    if (offenders.length > 0) {
      return {
        consignmentId: consignment.consignmentId,
        status: 'HELD_VARIANCE',
        variances,
        vendorNotice: `Consignment ${consignment.consignmentId} held: `
          + offenders.map((v) => `${v.sku} declared ${v.declaredUnits} received ${v.receivedUnits}`).join('; '),
      };
    }
    return { consignmentId: consignment.consignmentId, status: 'ACCEPTED', variances };
  }

  // ------------------------------------------------------------- putaway

  /** Putaway into a bin. A bin holds one SKU, so mixing is refused. */
  putaway(binId: string, sku: string, units: number, expiryMs?: number): PutawayResult {
    if (units <= 0) return { ok: false, reason: 'UNITS_MUST_BE_POSITIVE' };
    const existing = this.bins.get(binId);
    if (existing && existing.sku !== sku) {
      return { ok: false, reason: `BIN_HOLDS_A_DIFFERENT_SKU: ${existing.sku}` };
    }
    if (existing && existing.expiryMs !== expiryMs) {
      // mixing expiry dates in one bin defeats FEFO, because the bin can no longer be dated
      return { ok: false, reason: 'BIN_HOLDS_A_DIFFERENT_EXPIRY_DATE' };
    }
    const units_ = (existing?.units ?? 0) + units;
    this.bins.set(binId, { binId, sku, units: units_, expiryMs });
    return { ok: true, binId, units: units_ };
  }

  /** OUTPUTS: bin-accurate inventory, which is what FR-VEN-004 consumes as location. */
  binsFor(sku: string): Bin[] {
    return [...this.bins.values()].filter((b) => b.sku === sku && b.units > 0);
  }

  onHand(sku: string): number {
    return this.binsFor(sku).reduce((a, b) => a + b.units, 0);
  }

  bin(binId: string): Bin | undefined {
    return this.bins.get(binId);
  }

  // ------------------------------------------------------------- picking

  /**
   * RULES: FEFO for dated goods. The picker is directed to the earliest-expiring bin with enough
   * stock; undated stock falls back to the fullest bin so partial bins are consolidated.
   */
  private chooseBin(sku: string, qty: number): Bin | undefined {
    const candidates = this.binsFor(sku).filter((b) => b.units >= qty);
    if (candidates.length === 0) return undefined;
    const dated = candidates.filter((b) => b.expiryMs !== undefined);
    if (dated.length > 0) {
      return dated.sort((a, b) => a.expiryMs! - b.expiryMs! || a.binId.localeCompare(b.binId))[0];
    }
    return candidates.sort((a, b) => b.units - a.units || a.binId.localeCompare(b.binId))[0];
  }

  /** Build a wave of pick tasks for a set of order lines. */
  buildWave(waveId: string, lines: OrderLine[]): { tasks: PickTask[]; unfulfillable: string[] } {
    const tasks: PickTask[] = [];
    const unfulfillable: string[] = [];
    for (const line of lines) {
      const bin = this.chooseBin(line.sku, line.qty);
      if (!bin) {
        unfulfillable.push(line.lineId);
        continue;
      }
      tasks.push({
        taskId: `${waveId}-${line.lineId}`,
        lineId: line.lineId,
        sku: line.sku,
        qty: line.qty,
        binId: bin.binId,
        expiryMs: bin.expiryMs,
      });
    }
    return { tasks, unfulfillable };
  }

  /**
   * Confirm a pick. ERRORS: a bin mismatch raises an exception task and re-allocates from an
   * alternate bin rather than letting the picker take from wherever is convenient — which would
   * silently corrupt bin-accurate inventory.
   */
  confirmPick(task: PickTask, scannedBinId: string): PickResult {
    if (scannedBinId !== task.binId) {
      const alternate = this.chooseBin(task.sku, task.qty);
      return {
        ok: false,
        reason: `BIN_MISMATCH: directed ${task.binId}, scanned ${scannedBinId}`,
        exceptionTask: true,
        reallocatedBinId: alternate?.binId,
      };
    }
    const bin = this.bins.get(task.binId);
    if (!bin || bin.units < task.qty) {
      return { ok: false, reason: 'BIN_SHORT_AT_PICK', exceptionTask: true };
    }
    // FEFO enforcement: if an earlier-expiring bin exists with enough stock, this pick is wrong
    if (bin.expiryMs !== undefined) {
      const earlier = this.binsFor(task.sku)
        .filter((b) => b.units >= task.qty && b.expiryMs !== undefined && b.expiryMs < bin.expiryMs!);
      if (earlier.length > 0) {
        return {
          ok: false,
          reason: `FEFO_VIOLATION: bin ${earlier[0].binId} expires earlier`,
          exceptionTask: true,
          reallocatedBinId: earlier[0].binId,
        };
      }
    }
    this.bins.set(bin.binId, { ...bin, units: bin.units - task.qty });
    return { ok: true, task };
  }

  // ------------------------------------------------------------- pack

  /**
   * VALIDATION: scan-match enforced at pack. Every order line must be matched by a scan of the
   * barcode the item actually carries. A line left unmatched, a wrong barcode, or a scan for a
   * line not on the order all prevent the pack — the shipment does not exist until it verifies.
   */
  pack(shipmentId: string, lines: OrderLine[], scans: ScanMatch[]): PackResult {
    const scanByLine = new Map<string, string>();
    for (const s of scans) scanByLine.set(s.lineId, s.scannedBarcode);

    const unmatched: string[] = [];
    for (const line of lines) {
      const scanned = scanByLine.get(line.lineId);
      if (scanned === undefined) {
        unmatched.push(line.lineId);
        continue;
      }
      const expected = this.skuBarcodes.get(line.sku);
      if (expected === undefined || scanned !== expected) {
        unmatched.push(line.lineId);
      }
    }

    const strayScans = scans.filter((s) => !lines.some((l) => l.lineId === s.lineId));
    if (strayScans.length > 0) {
      return {
        ok: false,
        reason: `SCAN_FOR_LINE_NOT_ON_ORDER: ${strayScans.map((s) => s.lineId).join(',')}`,
        unmatchedLineIds: unmatched,
      };
    }
    if (unmatched.length > 0) {
      return { ok: false, reason: 'SCAN_MATCH_FAILED', unmatchedLineIds: unmatched };
    }
    if (lines.length === 0) {
      return { ok: false, reason: 'NOTHING_TO_PACK', unmatchedLineIds: [] };
    }
    return { ok: true, shipmentId, verifiedLineIds: lines.map((l) => l.lineId) };
  }

  // ------------------------------------------------------------- cycle counts

  /** RULES: a count variance beyond 0.5% triggers a recount and an investigation. */
  count(task: CountTask, countedUnits: number): CountResult {
    const varianceUnits = countedUnits - task.systemUnits;
    const ratio = task.systemUnits === 0
      ? (countedUnits === 0 ? 0 : 1)
      : Math.abs(varianceUnits) / task.systemUnits;
    const beyond = ratio > COUNT_VARIANCE_RECOUNT_THRESHOLD;
    return {
      taskId: task.taskId,
      binId: task.binId,
      sku: task.sku,
      systemUnits: task.systemUnits,
      countedUnits,
      varianceUnits,
      varianceRatio: Math.round(ratio * 100_000) / 100_000,
      recountRequired: beyond,
      investigationRequired: beyond,
    };
  }

  /** Apply a confirmed count, after any recount has settled. */
  applyCount(binId: string, countedUnits: number): { ok: boolean; reason?: string } {
    const bin = this.bins.get(binId);
    if (!bin) return { ok: false, reason: 'UNKNOWN_BIN' };
    if (countedUnits < 0) return { ok: false, reason: 'COUNT_CANNOT_BE_NEGATIVE' };
    this.bins.set(binId, { ...bin, units: countedUnits });
    return { ok: true };
  }

  // ------------------------------------------------------------- storage fees

  /**
   * RULES: storage fees accrue to vendor settlement as an FR-FIN-001 fee type. Expressed as an
   * accrual for the finance service to post, not as a ledger write from here.
   */
  static accrueStorage(vendorId: string, binDays: number, ratePaisePerBinDay: number): StorageAccrual {
    return {
      vendorId,
      binDays,
      ratePaisePerBinDay,
      amountPaise: Math.round(binDays * ratePaisePerBinDay),
      feeType: 'STORAGE',
    };
  }
}
