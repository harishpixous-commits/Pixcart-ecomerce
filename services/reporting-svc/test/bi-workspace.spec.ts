/**
 * FR-ADM-010 analytics & BI workspace. The suite is built around the semantic layer's purpose: a
 * metric has one definition, and the failure it prevents is two dashboards showing different GMV
 * with nobody able to say which is right.
 */
import { describe, expect, it } from 'vitest';
import {
  BiWorkspace,
  MAX_EXTRACT_ROWS,
  QUERY_LOG_RETENTION_MS,
  retentionMatrix,
  snapshot,
  type CohortMember,
  type Exploration,
  type Metric,
  type Role,
  type SemanticModel,
} from '../src/domain/bi-workspace.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const DAY = 86_400_000;

/**
 * GMV is visible to vendors as well as operators: a vendor seeing their OWN GMV is precisely what
 * vendor-scoped RLS is for. The role gate is exercised separately with a finance-only metric.
 */
const GMV_ROLES: ReadonlySet<Role> = new Set<Role>([
  'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'EXEC', 'MARKETING', 'VENDOR',
]);

const gmv = (over: Partial<Metric> = {}): Metric => ({
  metricName: 'gmv',
  expression: 'SUM(order_line.net_amount_paise)',
  unit: 'PAISE',
  certification: 'CERTIFIED',
  ownerTeam: 'finance-analytics',
  permittedRoles: GMV_ROLES,
  ...over,
});

const orders = (over: Partial<SemanticModel> = {}): SemanticModel => ({
  modelName: 'orders_certified',
  certification: 'CERTIFIED',
  metricNames: ['gmv', 'order_count'],
  dimensions: ['category', 'month', 'vendor_id'],
  vendorScoped: true,
  lastRefreshedAtMs: NOW - 3_600_000,
  ...over,
});

const exploration = (over: Partial<Exploration> = {}): Exploration => ({
  explorationId: 'EXP-1',
  modelNames: ['orders_certified'],
  metricNames: ['gmv'],
  dimensions: ['month'],
  filters: {},
  requestedRows: 10_000,
  ...over,
});

const workspace = () => {
  const w = new BiWorkspace();
  w.defineMetric(gmv());
  w.defineMetric(gmv({ metricName: 'order_count', expression: 'COUNT(order.id)', unit: 'COUNT' }));
  w.registerModel(orders());
  return w;
};

// ============================================ single source of truth

describe('a metric has ONE definition, in the semantic layer (RULES)', () => {
  it('resolves the certified GMV expression from the layer, not from the caller', () => {
    const w = workspace();
    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.metrics[0].metricName).toBe('gmv');
    expect(r.result.metrics[0].expression).toBe('SUM(order_line.net_amount_paise)');
    expect(r.result.metrics[0].unit).toBe('PAISE');
  });

  it('an Exploration has NO field through which an expression could be supplied', () => {
    // this is the single-source guarantee: a workspace where an analyst can redefine GMV inline
    // has as many GMVs as it has analysts
    expect('expression' in exploration()).toBe(false);
    expect(Object.keys(exploration()).sort()).toEqual([
      'dimensions', 'explorationId', 'filters', 'metricNames', 'modelNames', 'requestedRows',
    ]);
  });

  it('REFUSES a second, different definition of the same metric name', () => {
    const w = workspace();
    const r = w.defineMetric(gmv({ expression: 'SUM(order.gross_amount_paise)' }));
    expect(r.ok).toBe(false);
    // this is the exact failure the semantic layer exists to prevent
    if (!r.ok) expect(r.reason).toContain('METRIC_ALREADY_DEFINED_WITH_A_DIFFERENT_EXPRESSION');
    // and the original definition stands
    expect(w.metric('gmv')!.expression).toBe('SUM(order_line.net_amount_paise)');
  });

  it('accepts an idempotent redefinition with the identical expression', () => {
    const w = workspace();
    expect(w.defineMetric(gmv()).ok).toBe(true);
  });

  it('refuses a metric with no name or no expression', () => {
    const w = new BiWorkspace();
    expect(w.defineMetric(gmv({ metricName: '  ' })).ok).toBe(false);
    expect(w.defineMetric(gmv({ expression: '' })).ok).toBe(false);
  });

  it('the same metric resolves identically across different explorations', () => {
    const w = workspace();
    const a = w.explore(exploration({ explorationId: 'EXP-A', dimensions: ['month'] }), 'U1', 'ADMIN', NOW);
    const b = w.explore(exploration({ explorationId: 'EXP-B', dimensions: ['category'] }), 'U2', 'EXEC', NOW);
    if (!a.ok || !b.ok) throw new Error('expected results');
    expect(a.result.metrics[0].expression).toBe(b.result.metrics[0].expression);
  });
});

// ============================================ certified-only joins

describe('only CERTIFIED models may be joined (VALIDATION)', () => {
  it('permits a join of two certified models', () => {
    const w = workspace();
    w.registerModel(orders({ modelName: 'returns_certified', metricNames: ['gmv'], dimensions: ['month'] }));
    const r = w.explore(exploration({ modelNames: ['orders_certified', 'returns_certified'] }),
      'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.certified).toBe(true);
  });

  it('REFUSES a join that includes an uncertified model', () => {
    const w = workspace();
    w.registerModel(orders({
      modelName: 'experiment_raw', certification: 'UNCERTIFIED',
      metricNames: ['gmv'], dimensions: ['month'],
    }));
    const r = w.explore(exploration({ modelNames: ['orders_certified', 'experiment_raw'] }),
      'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const v = r.violations.find((x) => x.code === 'ONLY_CERTIFIED_MODELS_MAY_BE_JOINED')!;
      // joining launders unreviewed data into a result that would carry a certified badge, and
      // downgrading instead would only work if people read badges rather than trusting them
      expect(v.detail).toBe('experiment_raw');
    }
  });

  it('PERMITS exploring a single uncertified model, which is how one earns certification', () => {
    const w = workspace();
    w.registerModel(orders({
      modelName: 'experiment_raw', certification: 'UNCERTIFIED',
      metricNames: ['gmv'], dimensions: ['month'],
    }));
    const r = w.explore(exploration({ modelNames: ['experiment_raw'] }), 'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.certified).toBe(false);
  });

  it('refuses an unknown model and an unknown dimension', () => {
    const w = workspace();
    expect(w.explore(exploration({ modelNames: ['nope'] }), 'U', 'ADMIN', NOW).ok).toBe(false);
    const badDim = w.explore(exploration({ dimensions: ['made_up'] }), 'U', 'ADMIN', NOW);
    expect(badDim.ok).toBe(false);
    if (!badDim.ok) expect(badDim.violations.some((v) => v.code === 'UNKNOWN_DIMENSION')).toBe(true);
  });

  it('refuses a metric the selected model does not expose', () => {
    const w = workspace();
    w.defineMetric(gmv({ metricName: 'refund_rate', expression: 'x', unit: 'RATIO' }));
    const r = w.explore(exploration({ metricNames: ['refund_rate'] }), 'U', 'ADMIN', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((v) => v.code === 'METRIC_NOT_EXPOSED_BY_ANY_SELECTED_MODEL')).toBe(true);
    }
  });

  it('refuses a deprecated metric rather than silently returning stale semantics', () => {
    const w = new BiWorkspace();
    w.defineMetric(gmv({ metricName: 'gmv_old', certification: 'DEPRECATED' }));
    w.registerModel(orders({ metricNames: ['gmv_old'] }));
    const r = w.explore(exploration({ metricNames: ['gmv_old'] }), 'U', 'ADMIN', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code === 'METRIC_IS_DEPRECATED')).toBe(true);
  });

  it('refuses an exploration with no model or no metric', () => {
    const w = workspace();
    expect(w.explore(exploration({ modelNames: [] }), 'U', 'ADMIN', NOW).ok).toBe(false);
    expect(w.explore(exploration({ metricNames: [] }), 'U', 'ADMIN', NOW).ok).toBe(false);
  });
});

// ============================================ watermarking

describe('uncertified explorations are WATERMARKED (RULES)', () => {
  it('a fully certified exploration carries the badge and no watermark', () => {
    const w = workspace();
    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');
    expect(r.result.certified).toBe(true);
    expect(r.result.watermark).toBe('');
  });

  it('an uncertified MODEL watermarks the result', () => {
    const w = workspace();
    w.registerModel(orders({ modelName: 'raw', certification: 'UNCERTIFIED' }));
    const r = w.explore(exploration({ modelNames: ['raw'] }), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');
    expect(r.result.certified).toBe(false);
    expect(r.result.watermark).toContain('UNCERTIFIED');
    expect(r.result.watermark).toContain('board papers');
  });

  it('an uncertified METRIC watermarks the result even on a certified model', () => {
    const w = new BiWorkspace();
    w.defineMetric(gmv({ metricName: 'gmv_draft', certification: 'UNCERTIFIED' }));
    w.registerModel(orders({ metricNames: ['gmv_draft'] }));
    const r = w.explore(exploration({ metricNames: ['gmv_draft'] }), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');
    // certification is the AND of every model and every metric, not just the models
    expect(r.result.certified).toBe(false);
    expect(r.result.watermark).toContain('UNCERTIFIED');
  });

  it('a snapshot carries the badge and watermark forward', () => {
    const w = workspace();
    w.registerModel(orders({ modelName: 'raw', certification: 'UNCERTIFIED' }));
    const r = w.explore(exploration({ modelNames: ['raw'] }), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');

    const s = snapshot('SNAP-1', r.result, NOW);
    // a PDF read next quarter must not be mistaken for certified data it never was
    expect(s.certified).toBe(false);
    expect(s.watermark).toContain('UNCERTIFIED');
    expect(s.takenAtMs).toBe(NOW);
    expect(s.explorationId).toBe('EXP-1');
  });
});

// ============================================ RLS

describe('row-level security by role and vendor scope (SECURITY)', () => {
  it('refuses a role not permitted for the metric', () => {
    const w = new BiWorkspace();
    w.defineMetric(gmv({ permittedRoles: new Set<Role>(['FINANCE', 'SUPER_ADMIN']) }));
    w.registerModel(orders());
    const refused = w.explore(exploration(), 'MKT-1', 'MARKETING', NOW);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.violations.some((v) => v.code === 'ROLE_NOT_PERMITTED_FOR_METRIC')).toBe(true);
    }
    expect(w.explore(exploration(), 'FIN-1', 'FINANCE', NOW).ok).toBe(true);
  });

  it('a VENDOR caller must be scoped, and the scope is recorded on the result', () => {
    const w = workspace();
    const unscoped = w.explore(exploration(), 'VEN-1', 'VENDOR', NOW);
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) {
      expect(unscoped.violations.some((v) => v.code === 'VENDOR_SCOPE_REQUIRED_FOR_VENDOR_ROLE')).toBe(true);
    }

    const scoped = w.explore(exploration(), 'VEN-1', 'VENDOR', NOW, 'V-001');
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.result.vendorScopeApplied).toBe('V-001');
  });

  it('a VENDOR cannot explore a model that has no vendor column to scope by', () => {
    const w = workspace();
    w.registerModel(orders({ modelName: 'platform_wide', vendorScoped: false }));
    const r = w.explore(exploration({ modelNames: ['platform_wide'] }), 'VEN-1', 'VENDOR', NOW, 'V-001');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // an unscopeable model would return every vendor's rows, so it is refused rather than
      // filtered on a column that does not exist
      expect(r.violations.some((v) => v.code === 'VENDOR_CANNOT_EXPLORE_A_MODEL_WITHOUT_VENDOR_SCOPE'))
        .toBe(true);
    }
  });

  it('an operator role needs no vendor scope', () => {
    const w = workspace();
    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');
    expect(r.result.vendorScopeApplied).toBeUndefined();
  });
});

// ============================================ extract caps

describe('extract sizes are capped (VALIDATION)', () => {
  it('caps an over-large request rather than refusing it', () => {
    const w = workspace();
    const r = w.explore(exploration({ requestedRows: 5_000_000 }), 'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.rowCap).toBe(MAX_EXTRACT_ROWS);
    expect(MAX_EXTRACT_ROWS).toBe(250_000);
  });

  it('honours a request within the cap', () => {
    const w = workspace();
    const r = w.explore(exploration({ requestedRows: 1_000 }), 'ADM-1', 'ADMIN', NOW);
    if (r.ok) expect(r.result.rowCap).toBe(1_000);
  });

  it('treats a negative request as zero', () => {
    const w = workspace();
    const r = w.explore(exploration({ requestedRows: -50 }), 'ADM-1', 'ADMIN', NOW);
    if (r.ok) expect(r.result.rowCap).toBe(0);
  });
});

// ============================================ staleness

describe('a refresh failure shows last-good with a staleness flag (ERRORS)', () => {
  it('flags stale and names the model, without discarding the data', () => {
    const w = workspace();
    expect(w.recordRefreshFailure('orders_certified', NOW)).toBe(true);

    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.stale).toBe(true);
    expect(r.result.stalenessNote).toContain('last-good');
    expect(r.result.stalenessNote).toContain('orders_certified');
    // the dashboard still renders: a stale figure that says so beats an empty page
    expect(r.result.metrics).toHaveLength(1);
  });

  it('a successful refresh clears the flag', () => {
    const w = workspace();
    w.recordRefreshFailure('orders_certified', NOW);
    expect(w.recordRefreshSuccess('orders_certified', NOW + 3_600_000)).toBe(true);
    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW + 3_600_000);
    if (!r.ok) throw new Error('expected a result');
    expect(r.result.stale).toBe(false);
    expect(r.result.stalenessNote).toBe('');
  });

  it('a snapshot records that it was taken from stale data', () => {
    const w = workspace();
    w.recordRefreshFailure('orders_certified', NOW);
    const r = w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    if (!r.ok) throw new Error('expected a result');
    expect(snapshot('SNAP-1', r.result, NOW).stale).toBe(true);
  });

  it('recording a failure for an unknown model is harmless', () => {
    expect(workspace().recordRefreshFailure('nope', NOW)).toBe(false);
    expect(workspace().recordRefreshSuccess('nope', NOW)).toBe(false);
  });
});

// ============================================ query log

describe('query logs are retained, including refusals (SECURITY)', () => {
  it('logs a successful exploration with its actor, role and scope', () => {
    const w = workspace();
    w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    const log = w.queryLogEntries();
    expect(log).toHaveLength(1);
    expect(log[0].actorId).toBe('ADM-1');
    expect(log[0].role).toBe('ADMIN');
    expect(log[0].metricNames).toEqual(['gmv']);
    expect(log[0].refused).toBe(false);
    expect(log[0].rowsReturned).toBe(10_000);
  });

  it('LOGS A REFUSAL with its codes, which is the entry an audit actually wants', () => {
    const w = workspace();
    w.explore(exploration(), 'VEN-1', 'VENDOR', NOW);          // no vendor scope
    const log = w.queryLogEntries();
    expect(log).toHaveLength(1);
    // a log that records only successful queries cannot show who tried to reach what
    expect(log[0].refused).toBe(true);
    expect(log[0].refusalCodes).toContain('VENDOR_SCOPE_REQUIRED_FOR_VENDOR_ROLE');
    expect(log[0].rowsReturned).toBe(0);
  });

  it('reports entries inside the retention window', () => {
    const w = workspace();
    w.explore(exploration(), 'ADM-1', 'ADMIN', NOW);
    expect(w.retainedQueryLog(NOW + QUERY_LOG_RETENTION_MS)).toHaveLength(1);
    expect(w.retainedQueryLog(NOW + QUERY_LOG_RETENTION_MS + 1)).toHaveLength(0);
  });
});

// ============================================ retention matrix

describe('the cohort retention matrix omits periods a cohort has not reached (OUTPUTS)', () => {
  const members = (): CohortMember[] => [
    { customerId: 'A', cohortPeriod: 0, activePeriods: [0, 1, 2] },
    { customerId: 'B', cohortPeriod: 0, activePeriods: [0, 1] },
    { customerId: 'C', cohortPeriod: 0, activePeriods: [0] },
    { customerId: 'D', cohortPeriod: 2, activePeriods: [2] },
  ];

  it('period zero is 100% by construction and is emitted, not suppressed', () => {
    const cells = retentionMatrix(members(), 3);
    const zero = cells.find((c) => c.cohortPeriod === 0 && c.periodsSinceJoin === 0)!;
    // an analyst comparing cohorts needs the denominator visible
    expect(zero.cohortSize).toBe(3);
    expect(zero.retained).toBe(3);
    expect(zero.retentionRate).toBe(1);
  });

  it('computes the decay across periods', () => {
    const cells = retentionMatrix(members(), 3);
    const cohortZero = cells.filter((c) => c.cohortPeriod === 0);
    expect(cohortZero.map((c) => c.retained)).toEqual([3, 2, 1]);
    expect(cohortZero[1].retentionRate).toBeCloseTo(0.6667, 3);
  });

  it('OMITS a period a younger cohort has not yet reached rather than showing zero', () => {
    const cells = retentionMatrix(members(), 3);
    const cohortTwo = cells.filter((c) => c.cohortPeriod === 2);
    // a cohort that joined last month has not failed to retain at month six; a zero there would
    // read as catastrophic churn
    expect(cohortTwo).toHaveLength(1);
    expect(cohortTwo[0].periodsSinceJoin).toBe(0);
    expect(cells.some((c) => c.cohortPeriod === 2 && c.periodsSinceJoin > 0)).toBe(false);
  });

  it('handles an empty membership list', () => {
    expect(retentionMatrix([], 6)).toEqual([]);
  });

  it('a cohort with a gap in activity shows the dip honestly', () => {
    const lapsed: CohortMember[] = [
      { customerId: 'A', cohortPeriod: 0, activePeriods: [0, 2] },
      { customerId: 'B', cohortPeriod: 0, activePeriods: [0, 1, 2] },
    ];
    const cells = retentionMatrix(lapsed, 3);
    expect(cells.map((c) => c.retained)).toEqual([2, 1, 2]);
  });
});
