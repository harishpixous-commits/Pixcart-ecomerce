/**
 * Operational reports — FR-ADM-009.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "parameterised operational reports (orders, payments, settlements, returns,
 *                inventory, catalogue, vendor performance, tax) with schedule-and-email
 *                delivery and warehouse-grade CSV/XLSX exports."
 *   RULES:      "All reports read replicas/lakehouse (never OLTP primary); figures footnoted
 *                with freshness & filters."
 *   ACCEPTANCE: "Given a scheduled daily settlements report, When 07:00 IST run completes, Then
 *                recipients receive a signed link and the run log stores checksum + row count."
 *   VALIDATION: "Parameter ranges bounded; recipient domain allow-list; PII columns role-gated."
 *
 * Pure and deterministic, with one real dependency: the checksum uses node:crypto SHA-256 so
 * the run log records a genuine content hash rather than a toy digest — two runs over identical
 * rows produce the same checksum, and a single changed cell changes it.
 *
 * The OLTP-primary refusal is structural: {@link runReport} rejects that source before doing
 * any work, so no code path can accidentally read the transactional primary for reporting.
 */
import { createHash } from 'node:crypto';

export type ReportKind =
  | 'ORDERS' | 'PAYMENTS' | 'SETTLEMENTS' | 'RETURNS'
  | 'INVENTORY' | 'CATALOGUE' | 'VENDOR_PERFORMANCE' | 'TAX';

export type DataSource = 'REPLICA' | 'LAKEHOUSE' | 'OLTP_PRIMARY';

/** Columns flagged PII are role-gated (VALIDATION). */
export interface ColumnSpec {
  name: string;
  pii: boolean;
}

export interface ReportParameters {
  fromMs: number;
  toMs: number;
  filters: Record<string, string>;
}

export interface ReportSpec {
  reportId: string;
  kind: ReportKind;
  parameters: ReportParameters;
  columns: ColumnSpec[];
  recipients: string[];
  /** Local hour and minute in IST for a daily schedule, e.g. 7:00. */
  dailyAtIstHour?: number;
  dailyAtIstMinute?: number;
}

/** Maximum parameter window per report kind (VALIDATION: "parameter ranges bounded"). */
export const MAX_RANGE_DAYS: Record<ReportKind, number> = {
  ORDERS: 90, PAYMENTS: 90, SETTLEMENTS: 366, RETURNS: 90,
  INVENTORY: 31, CATALOGUE: 31, VENDOR_PERFORMANCE: 366, TAX: 366,
};

export const SIGNED_LINK_TTL_MS = 24 * 3600 * 1000;
const IST_OFFSET_MINUTES = 330;

export interface RunLogEntry {
  runId: string;
  reportId: string;
  kind: ReportKind;
  startedAtMs: number;
  completedAtMs: number;
  rowCount: number;
  /** SHA-256 over the canonical rendering of the rows. */
  checksumSha256: string;
  source: DataSource;
  /** RULES: figures footnoted with freshness & filters. */
  footnote: string;
  recipients: string[];
}

export interface SignedLink {
  url: string;
  token: string;
  expiresAtMs: number;
}

export type RunResult =
  | { ok: true; log: RunLogEntry; link: SignedLink }
  | { ok: false; violations: string[] };

/** Validate a spec before running. Every violation is reported, not just the first. */
export function validateSpec(
  spec: ReportSpec,
  source: DataSource,
  allowedRecipientDomains: Set<string>,
  requesterMaySeePii: boolean,
  nowMs: number,
): string[] {
  const v: string[] = [];

  // RULES: never the OLTP primary.
  if (source === 'OLTP_PRIMARY') v.push('REPORTS_MUST_NOT_READ_OLTP_PRIMARY');

  // parameter bounds
  const { fromMs, toMs } = spec.parameters;
  if (toMs <= fromMs) v.push('RANGE_INVERTED');
  const days = (toMs - fromMs) / (24 * 3600 * 1000);
  const maxDays = MAX_RANGE_DAYS[spec.kind];
  if (days > maxDays) v.push(`RANGE_EXCEEDS_${maxDays}_DAYS_FOR_${spec.kind} (got ${Math.round(days)})`);
  if (toMs > nowMs) v.push('RANGE_END_IN_FUTURE');

  // recipient domain allow-list
  if (spec.recipients.length === 0) v.push('AT_LEAST_ONE_RECIPIENT_REQUIRED');
  for (const r of spec.recipients) {
    const at = r.lastIndexOf('@');
    if (at < 0) { v.push(`RECIPIENT_MALFORMED: ${r}`); continue; }
    const domain = r.slice(at + 1).toLowerCase();
    if (!allowedRecipientDomains.has(domain)) v.push(`RECIPIENT_DOMAIN_NOT_ALLOWED: ${domain}`);
  }

  // PII columns are role-gated
  const piiColumns = spec.columns.filter((c) => c.pii).map((c) => c.name);
  if (piiColumns.length > 0 && !requesterMaySeePii) {
    v.push(`PII_COLUMNS_NOT_PERMITTED: ${piiColumns.join(',')}`);
  }

  if (spec.columns.length === 0) v.push('AT_LEAST_ONE_COLUMN_REQUIRED');
  return v;
}

/** Canonical rendering used for the checksum: column order fixed by the spec, tab-delimited. */
export function canonicalRows(spec: ReportSpec, rows: Array<Record<string, string>>): string {
  const header = spec.columns.map((c) => c.name).join('\t');
  const body = rows.map((r) => spec.columns.map((c) => r[c.name] ?? '').join('\t'));
  return [header, ...body].join('\n');
}

export function checksumOf(spec: ReportSpec, rows: Array<Record<string, string>>): string {
  return createHash('sha256').update(canonicalRows(spec, rows), 'utf8').digest('hex');
}

/**
 * Execute a report run. On success the run log carries the row count and a real SHA-256
 * checksum, and recipients get a signed, expiring link — the acceptance criterion.
 */
export function runReport(
  spec: ReportSpec,
  source: DataSource,
  rows: Array<Record<string, string>>,
  opts: {
    allowedRecipientDomains: Set<string>;
    requesterMaySeePii: boolean;
    replicaLagSeconds: number;
    startedAtMs: number;
    completedAtMs: number;
    runId: string;
    signingSecret: string;
  },
): RunResult {
  const violations = validateSpec(spec, source, opts.allowedRecipientDomains,
    opts.requesterMaySeePii, opts.completedAtMs);
  if (violations.length > 0) return { ok: false, violations };

  const filterText = Object.entries(spec.parameters.filters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, val]) => `${k}=${val}`)
    .join('; ') || 'none';
  const footnote = `source=${source}; freshness=${opts.replicaLagSeconds}s behind primary; `
    + `range=${new Date(spec.parameters.fromMs).toISOString()}..${new Date(spec.parameters.toMs).toISOString()}; `
    + `filters=${filterText}`;

  const checksum = checksumOf(spec, rows);
  const token = createHash('sha256')
    .update(`${opts.signingSecret}|${spec.reportId}|${opts.runId}|${checksum}`, 'utf8')
    .digest('hex')
    .slice(0, 32);

  return {
    ok: true,
    log: {
      runId: opts.runId,
      reportId: spec.reportId,
      kind: spec.kind,
      startedAtMs: opts.startedAtMs,
      completedAtMs: opts.completedAtMs,
      rowCount: rows.length,
      checksumSha256: checksum,
      source,
      footnote,
      recipients: [...spec.recipients],
    },
    link: {
      url: `https://reports.pixcart.pixoustech.com/${spec.reportId}/${opts.runId}?sig=${token}`,
      token,
      expiresAtMs: opts.completedAtMs + SIGNED_LINK_TTL_MS,
    },
  };
}

export function isLinkValid(link: SignedLink, atMs: number): boolean {
  return atMs < link.expiresAtMs;
}

/**
 * Next run instant for a daily IST schedule (e.g. 07:00 IST). Computed rather than stored, so a
 * missed tick cannot desynchronise the schedule.
 */
export function nextDailyRunMs(spec: ReportSpec, afterMs: number): number | null {
  if (spec.dailyAtIstHour === undefined) return null;
  const hour = spec.dailyAtIstHour;
  const minute = spec.dailyAtIstMinute ?? 0;
  const offsetMs = IST_OFFSET_MINUTES * 60_000;
  const localMs = afterMs + offsetMs;
  const dayStartLocal = Math.floor(localMs / 86_400_000) * 86_400_000;
  let candidateLocal = dayStartLocal + hour * 3_600_000 + minute * 60_000;
  if (candidateLocal <= localMs) candidateLocal += 86_400_000;
  return candidateLocal - offsetMs;
}
