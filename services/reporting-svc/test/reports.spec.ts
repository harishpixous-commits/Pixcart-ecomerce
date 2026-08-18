/**
 * FR-ADM-009 as tests, including the documented acceptance scenario: a scheduled daily
 * settlements report completing at 07:00 IST must deliver a signed link and record a checksum
 * and row count in the run log.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalRows,
  checksumOf,
  isLinkValid,
  MAX_RANGE_DAYS,
  nextDailyRunMs,
  runReport,
  SIGNED_LINK_TTL_MS,
  validateSpec,
  type ReportSpec,
} from '../src/domain/reports.js';

const DAY = 24 * 3600 * 1000;
const ALLOWED = new Set(['pixoustech.com']);
// 2026-08-20 07:00 IST = 01:30 UTC
const RUN_AT = Date.UTC(2026, 7, 20, 1, 30, 0);

const spec = (over: Partial<ReportSpec> = {}): ReportSpec => ({
  reportId: 'RPT-SETTLEMENTS-DAILY',
  kind: 'SETTLEMENTS',
  parameters: { fromMs: RUN_AT - 1 * DAY, toMs: RUN_AT - 1, filters: { vendorTier: 'ALL' } },
  columns: [
    { name: 'batch_id', pii: false },
    { name: 'vendor_id', pii: false },
    { name: 'amount_paise', pii: false },
    { name: 'utr', pii: false },
  ],
  recipients: ['finance@pixoustech.com'],
  dailyAtIstHour: 7,
  dailyAtIstMinute: 0,
  ...over,
});

const rows = [
  { batch_id: 'BATCH-W34', vendor_id: 'V1', amount_paise: '5400000', utr: 'UTR-V1' },
  { batch_id: 'BATCH-W34', vendor_id: 'V2', amount_paise: '5400000', utr: 'UTR-V2' },
];

const runOpts = (over: Partial<Parameters<typeof runReport>[3]> = {}) => ({
  allowedRecipientDomains: ALLOWED,
  requesterMaySeePii: false,
  replicaLagSeconds: 42,
  startedAtMs: RUN_AT - 30_000,
  completedAtMs: RUN_AT,
  runId: 'RUN-0001',
  signingSecret: 'x'.repeat(40),
  ...over,
});

describe('the documented acceptance scenario: daily settlements report at 07:00 IST', () => {
  it('completes with a signed link and a run log carrying checksum and row count', () => {
    const r = runReport(spec(), 'REPLICA', rows, runOpts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.log.rowCount).toBe(2);
    expect(r.log.checksumSha256).toMatch(/^[0-9a-f]{64}$/);       // a real SHA-256
    expect(r.log.kind).toBe('SETTLEMENTS');
    expect(r.log.recipients).toEqual(['finance@pixoustech.com']);
    expect(r.link.url).toContain('RPT-SETTLEMENTS-DAILY');
    expect(r.link.url).toContain(r.link.token);
    expect(r.link.expiresAtMs).toBe(RUN_AT + SIGNED_LINK_TTL_MS);
    expect(isLinkValid(r.link, RUN_AT + SIGNED_LINK_TTL_MS - 1)).toBe(true);
    expect(isLinkValid(r.link, RUN_AT + SIGNED_LINK_TTL_MS)).toBe(false);
  });

  it('the schedule resolves to 07:00 IST and advances a day at a time', () => {
    // just before the run: next is today 07:00 IST
    expect(nextDailyRunMs(spec(), RUN_AT - 60_000)).toBe(RUN_AT);
    // exactly at the run: next is tomorrow, so a tick cannot fire twice
    expect(nextDailyRunMs(spec(), RUN_AT)).toBe(RUN_AT + DAY);
    // late in the IST day it still lands on tomorrow 07:00
    expect(nextDailyRunMs(spec(), RUN_AT + 12 * 3600 * 1000)).toBe(RUN_AT + DAY);
    expect(nextDailyRunMs(spec({ dailyAtIstHour: undefined }), RUN_AT)).toBeNull();
  });
});

describe('RULES: never the OLTP primary; figures footnoted', () => {
  it('refuses to run against the transactional primary', () => {
    const r = runReport(spec(), 'OLTP_PRIMARY', rows, runOpts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('REPORTS_MUST_NOT_READ_OLTP_PRIMARY');
  });

  it('accepts a replica or the lakehouse', () => {
    expect(runReport(spec(), 'REPLICA', rows, runOpts()).ok).toBe(true);
    expect(runReport(spec(), 'LAKEHOUSE', rows, runOpts()).ok).toBe(true);
  });

  it('footnotes freshness, range and filters', () => {
    const r = runReport(spec({ parameters: { fromMs: RUN_AT - DAY, toMs: RUN_AT - 1, filters: { state: 'TN', vendorTier: 'GOLD' } } }),
      'REPLICA', rows, runOpts({ replicaLagSeconds: 12 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.log.footnote).toContain('source=REPLICA');
    expect(r.log.footnote).toContain('freshness=12s behind primary');
    expect(r.log.footnote).toContain('state=TN');
    expect(r.log.footnote).toContain('vendorTier=GOLD');
  });

  it('records "none" when no filters were applied', () => {
    const r = runReport(spec({ parameters: { fromMs: RUN_AT - DAY, toMs: RUN_AT - 1, filters: {} } }),
      'REPLICA', rows, runOpts());
    if (!r.ok) throw new Error('expected ok');
    expect(r.log.footnote).toContain('filters=none');
  });
});

describe('VALIDATION: bounded parameters', () => {
  it('enforces a per-kind maximum range', () => {
    expect(MAX_RANGE_DAYS.INVENTORY).toBe(31);
    const tooWide = runReport(
      spec({ kind: 'INVENTORY', parameters: { fromMs: RUN_AT - 60 * DAY, toMs: RUN_AT - 1, filters: {} } }),
      'REPLICA', rows, runOpts());
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.violations.some((v) => v.startsWith('RANGE_EXCEEDS_31_DAYS'))).toBe(true);

    // settlements allow a full year
    expect(runReport(
      spec({ parameters: { fromMs: RUN_AT - 300 * DAY, toMs: RUN_AT - 1, filters: {} } }),
      'REPLICA', rows, runOpts()).ok).toBe(true);
  });

  it('rejects an inverted range and a range ending in the future', () => {
    const inverted = validateSpec(spec({ parameters: { fromMs: RUN_AT, toMs: RUN_AT - DAY, filters: {} } }),
      'REPLICA', ALLOWED, false, RUN_AT);
    expect(inverted).toContain('RANGE_INVERTED');

    const future = validateSpec(spec({ parameters: { fromMs: RUN_AT - DAY, toMs: RUN_AT + DAY, filters: {} } }),
      'REPLICA', ALLOWED, false, RUN_AT);
    expect(future).toContain('RANGE_END_IN_FUTURE');
  });
});

describe('VALIDATION: recipient domain allow-list', () => {
  it('refuses a recipient outside the allow-list and names the domain', () => {
    const r = runReport(spec({ recipients: ['finance@pixoustech.com', 'leak@gmail.com'] }),
      'REPLICA', rows, runOpts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('RECIPIENT_DOMAIN_NOT_ALLOWED: gmail.com');
  });

  it('refuses a malformed recipient and an empty recipient list', () => {
    const malformed = validateSpec(spec({ recipients: ['not-an-email'] }), 'REPLICA', ALLOWED, false, RUN_AT);
    expect(malformed.some((v) => v.startsWith('RECIPIENT_MALFORMED'))).toBe(true);
    const none = validateSpec(spec({ recipients: [] }), 'REPLICA', ALLOWED, false, RUN_AT);
    expect(none).toContain('AT_LEAST_ONE_RECIPIENT_REQUIRED');
  });
});

describe('VALIDATION: PII columns are role-gated', () => {
  const withPii = spec({
    columns: [
      { name: 'order_id', pii: false },
      { name: 'customer_email', pii: true },
      { name: 'customer_mobile', pii: true },
    ],
  });

  it('a requester without PII rights cannot run a report containing PII columns', () => {
    const r = runReport(withPii, 'REPLICA', [], runOpts({ requesterMaySeePii: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((v) => v.startsWith('PII_COLUMNS_NOT_PERMITTED'))).toBe(true);
      expect(r.violations.some((v) => v.includes('customer_email') && v.includes('customer_mobile'))).toBe(true);
    }
  });

  it('the same report runs for a requester who holds PII rights', () => {
    expect(runReport(withPii, 'REPLICA', [], runOpts({ requesterMaySeePii: true })).ok).toBe(true);
  });

  it('a report with no PII columns needs no PII rights', () => {
    expect(runReport(spec(), 'REPLICA', rows, runOpts({ requesterMaySeePii: false })).ok).toBe(true);
  });

  it('every violation is reported at once, not just the first', () => {
    const r = runReport(spec({
      kind: 'INVENTORY',
      parameters: { fromMs: RUN_AT - 90 * DAY, toMs: RUN_AT + DAY, filters: {} },
      recipients: ['x@gmail.com'],
      columns: [{ name: 'customer_email', pii: true }],
    }), 'OLTP_PRIMARY', rows, runOpts({ requesterMaySeePii: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.length).toBeGreaterThanOrEqual(5);
  });
});

describe('checksum integrity', () => {
  it('is stable for identical content and changes when one cell changes', () => {
    const s = spec();
    const a = checksumOf(s, rows);
    const b = checksumOf(s, rows.map((r) => ({ ...r })));
    expect(a).toBe(b);

    const tampered = [{ ...rows[0], amount_paise: '5400001' }, rows[1]];
    expect(checksumOf(s, tampered)).not.toBe(a);
  });

  it('depends on column order, so a re-ordered export is a different artefact', () => {
    const s1 = spec();
    const s2 = spec({ columns: [s1.columns[1], s1.columns[0], s1.columns[2], s1.columns[3]] });
    expect(checksumOf(s2, rows)).not.toBe(checksumOf(s1, rows));
  });

  it('canonical rendering starts with the header row', () => {
    expect(canonicalRows(spec(), rows).split('\n')[0]).toBe('batch_id\tvendor_id\tamount_paise\tutr');
  });

  it('an empty result set still produces a checksum and a zero row count', () => {
    const r = runReport(spec(), 'REPLICA', [], runOpts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.log.rowCount).toBe(0);
    expect(r.log.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
