/**
 * Analytics & BI workspace — FR-ADM-010.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "expose a governed BI workspace (semantic models over the lakehouse) for
 *                cohorting, funnel, retention, category and vendor analytics with saved dashboards
 *                and row-level security."
 *   INPUTS:     "Explorations on published models, dashboard curation, subscription setup."
 *   OUTPUTS:    "Dashboards with drill paths, cohort/retention matrices, scheduled snapshots,
 *                certified-metric badges."
 *   VALIDATION: "Only certified models joinable; extract sizes capped."
 *   RULES:      "Metric definitions live in the semantic layer (single source, Vol. 6 §6.9);
 *                'uncertified' explorations watermarked."
 *   ERRORS:     "Model refresh fail → dashboards show last-good with staleness flag."
 *   SECURITY:   "RLS by role/vendor-scope; query logs retained."
 *   ACCEPTANCE: "Given the certified 'GMV' [metric, it resolves identically wherever it is used]."
 *
 * THE POINT OF A SEMANTIC LAYER IS THAT A METRIC HAS ONE DEFINITION, and the failure it exists to
 * prevent is two dashboards showing different GMV and nobody able to say which is right. So a
 * metric's expression lives here and nowhere else: an exploration REFERENCES a metric by name and
 * cannot supply its own expression, which is asserted by there being no field to supply one
 * through. A workspace where an analyst can redefine GMV inline is a workspace with as many GMVs
 * as it has analysts.
 *
 * The join rule follows from the same idea. Joining a certified model to an uncertified one
 * launders unreviewed data into a result that would otherwise carry a certified badge, so the join
 * is REFUSED rather than permitted-and-downgraded. Downgrading would be defensible if anyone read
 * badges, but the whole reason for certification is that people trust the badge instead of
 * reading.
 */

/** VALIDATION: extract row ceiling. */
export const MAX_EXTRACT_ROWS = 250_000;
/** SECURITY: how long query logs are retained. */
export const QUERY_LOG_RETENTION_MS = 400 * 24 * 3_600_000;

export type Certification = 'CERTIFIED' | 'UNCERTIFIED' | 'DEPRECATED';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'FINANCE' | 'MARKETING' | 'EXEC' | 'VENDOR';

/** A metric, defined once. Its expression lives in the semantic layer and only here. */
export interface Metric {
  metricName: string;
  /** The single source of truth for how this metric is computed. */
  expression: string;
  unit: 'PAISE' | 'COUNT' | 'RATIO';
  certification: Certification;
  ownerTeam: string;
  /** Roles permitted to query this metric at all. */
  permittedRoles: ReadonlySet<Role>;
}

export interface SemanticModel {
  modelName: string;
  certification: Certification;
  /** Metric names this model exposes. */
  metricNames: string[];
  /** Dimensions available for grouping. */
  dimensions: string[];
  /** True when rows carry a vendor id, and so must be vendor-scoped for a vendor caller. */
  vendorScoped: boolean;
  lastRefreshedAtMs: number;
  /** ERRORS: set when the most recent refresh failed and this is last-good data. */
  refreshFailedAtMs?: number;
}

export interface Violation {
  code: string;
  detail: string;
}

/**
 * An exploration. Note there is NO expression field: a metric is referenced by name, and its
 * definition is resolved from the semantic layer. That absence is the single-source guarantee.
 */
export interface Exploration {
  explorationId: string;
  modelNames: string[];
  metricNames: string[];
  dimensions: string[];
  filters: Record<string, string>;
  requestedRows: number;
}

export interface ResolvedMetric {
  metricName: string;
  /** Resolved from the semantic layer, never supplied by the caller. */
  expression: string;
  unit: Metric['unit'];
  certification: Certification;
}

export interface ExplorationResult {
  explorationId: string;
  metrics: ResolvedMetric[];
  modelNames: string[];
  /** OUTPUTS: the certified-metric badge. */
  certified: boolean;
  /** RULES: an uncertified exploration is watermarked. */
  watermark: string;
  rowCap: number;
  /** ERRORS: last-good data, with the staleness stated. */
  stale: boolean;
  stalenessNote: string;
  /** SECURITY: the vendor filter actually applied, if any. */
  vendorScopeApplied?: string;
  drillPaths: string[];
}

export type ExploreOutcome =
  | { ok: true; result: ExplorationResult }
  | { ok: false; violations: Violation[] };

export interface QueryLogEntry {
  atMs: number;
  explorationId: string;
  actorId: string;
  role: Role;
  modelNames: string[];
  metricNames: string[];
  rowsReturned: number;
  vendorScopeApplied?: string;
  refused: boolean;
  refusalCodes: string[];
}

export class BiWorkspace {
  private readonly metrics = new Map<string, Metric>();
  private readonly models = new Map<string, SemanticModel>();
  private readonly queryLog: QueryLogEntry[] = [];

  /** RULES: a metric definition is registered once, in the semantic layer. */
  defineMetric(metric: Metric): { ok: true } | { ok: false; reason: string } {
    if (!metric.metricName || metric.metricName.trim().length === 0) {
      return { ok: false, reason: 'METRIC_NAME_REQUIRED' };
    }
    if (!metric.expression || metric.expression.trim().length === 0) {
      return { ok: false, reason: 'METRIC_EXPRESSION_REQUIRED' };
    }
    const existing = this.metrics.get(metric.metricName);
    if (existing && existing.expression !== metric.expression) {
      // a second, different definition of the same name is the exact failure the semantic layer
      // exists to prevent
      return {
        ok: false,
        reason: `METRIC_ALREADY_DEFINED_WITH_A_DIFFERENT_EXPRESSION: ${metric.metricName}`,
      };
    }
    this.metrics.set(metric.metricName, metric);
    return { ok: true };
  }

  registerModel(model: SemanticModel): void {
    this.models.set(model.modelName, model);
  }

  metric(metricName: string): Metric | undefined {
    return this.metrics.get(metricName);
  }

  model(modelName: string): SemanticModel | undefined {
    return this.models.get(modelName);
  }

  /** ERRORS: mark a refresh failure without discarding the last-good data. */
  recordRefreshFailure(modelName: string, atMs: number): boolean {
    const m = this.models.get(modelName);
    if (!m) return false;
    m.refreshFailedAtMs = atMs;
    return true;
  }

  recordRefreshSuccess(modelName: string, atMs: number): boolean {
    const m = this.models.get(modelName);
    if (!m) return false;
    m.lastRefreshedAtMs = atMs;
    m.refreshFailedAtMs = undefined;
    return true;
  }

  /**
   * Run an exploration.
   *
   * VALIDATION: only certified models may be JOINED. A single uncertified model may be explored on
   * its own — that is how a model earns certification — but combining it with a certified one
   * would launder unreviewed data into a result carrying a certified badge.
   */
  explore(exploration: Exploration, actorId: string, role: Role, nowMs: number,
          vendorId?: string): ExploreOutcome {
    const violations: Violation[] = [];

    if (exploration.modelNames.length === 0) {
      violations.push({ code: 'AT_LEAST_ONE_MODEL_REQUIRED', detail: '' });
    }
    if (exploration.metricNames.length === 0) {
      violations.push({ code: 'AT_LEAST_ONE_METRIC_REQUIRED', detail: '' });
    }

    const models: SemanticModel[] = [];
    for (const name of exploration.modelNames) {
      const m = this.models.get(name);
      if (!m) violations.push({ code: 'UNKNOWN_MODEL', detail: name });
      else models.push(m);
    }

    // VALIDATION: only certified models are joinable
    if (models.length > 1) {
      const uncertified = models.filter((m) => m.certification !== 'CERTIFIED');
      if (uncertified.length > 0) {
        violations.push({
          code: 'ONLY_CERTIFIED_MODELS_MAY_BE_JOINED',
          detail: uncertified.map((m) => m.modelName).join(', '),
        });
      }
    }

    const resolved: ResolvedMetric[] = [];
    for (const metricName of exploration.metricNames) {
      const metric = this.metrics.get(metricName);
      if (!metric) {
        violations.push({ code: 'UNKNOWN_METRIC', detail: metricName });
        continue;
      }
      if (metric.certification === 'DEPRECATED') {
        violations.push({ code: 'METRIC_IS_DEPRECATED', detail: metricName });
        continue;
      }
      // SECURITY: role gate on the metric itself
      if (!metric.permittedRoles.has(role)) {
        violations.push({ code: 'ROLE_NOT_PERMITTED_FOR_METRIC', detail: `${role} / ${metricName}` });
        continue;
      }
      // a metric must actually be exposed by one of the models being explored
      if (!models.some((m) => m.metricNames.includes(metricName))) {
        violations.push({
          code: 'METRIC_NOT_EXPOSED_BY_ANY_SELECTED_MODEL',
          detail: metricName,
        });
        continue;
      }
      resolved.push({
        metricName: metric.metricName,
        // RULES: resolved from the semantic layer — the caller could not have supplied this
        expression: metric.expression,
        unit: metric.unit,
        certification: metric.certification,
      });
    }

    // SECURITY: a vendor caller must be scoped, and cannot explore a model with no vendor column
    let vendorScopeApplied: string | undefined;
    if (role === 'VENDOR') {
      if (!vendorId) {
        violations.push({ code: 'VENDOR_SCOPE_REQUIRED_FOR_VENDOR_ROLE', detail: '' });
      } else if (models.some((m) => !m.vendorScoped)) {
        violations.push({
          code: 'VENDOR_CANNOT_EXPLORE_A_MODEL_WITHOUT_VENDOR_SCOPE',
          detail: models.filter((m) => !m.vendorScoped).map((m) => m.modelName).join(', '),
        });
      } else {
        vendorScopeApplied = vendorId;
      }
    }

    for (const d of exploration.dimensions) {
      if (!models.some((m) => m.dimensions.includes(d))) {
        violations.push({ code: 'UNKNOWN_DIMENSION', detail: d });
      }
    }

    if (violations.length > 0) {
      this.queryLog.push({
        atMs: nowMs,
        explorationId: exploration.explorationId,
        actorId,
        role,
        modelNames: [...exploration.modelNames],
        metricNames: [...exploration.metricNames],
        rowsReturned: 0,
        vendorScopeApplied,
        refused: true,
        refusalCodes: violations.map((v) => v.code),
      });
      return { ok: false, violations };
    }

    // VALIDATION: extract sizes capped
    const rowCap = Math.min(MAX_EXTRACT_ROWS, Math.max(0, exploration.requestedRows));

    // OUTPUTS: the badge is certified only when EVERY model and EVERY metric is
    const allCertified = models.every((m) => m.certification === 'CERTIFIED')
      && resolved.every((m) => m.certification === 'CERTIFIED');

    // ERRORS: last-good with a staleness flag
    const failed = models.filter((m) => m.refreshFailedAtMs !== undefined);
    const stale = failed.length > 0;
    const stalenessNote = stale
      ? `Showing last-good data: ${failed.map((m) => m.modelName).join(', ')} `
        + `last refreshed ${new Date(Math.min(...failed.map((m) => m.lastRefreshedAtMs))).toISOString()}`
      : '';

    this.queryLog.push({
      atMs: nowMs,
      explorationId: exploration.explorationId,
      actorId,
      role,
      modelNames: [...exploration.modelNames],
      metricNames: [...exploration.metricNames],
      rowsReturned: rowCap,
      vendorScopeApplied,
      refused: false,
      refusalCodes: [],
    });

    return {
      ok: true,
      result: {
        explorationId: exploration.explorationId,
        metrics: resolved,
        modelNames: models.map((m) => m.modelName),
        certified: allCertified,
        // RULES: uncertified explorations are watermarked
        watermark: allCertified
          ? ''
          : 'UNCERTIFIED — not for external reporting or board papers',
        rowCap,
        stale,
        stalenessNote,
        vendorScopeApplied,
        drillPaths: exploration.dimensions.map((d) => `drill:${d}`),
      },
    };
  }

  /** SECURITY: the retained query log. */
  queryLogEntries(): QueryLogEntry[] {
    return [...this.queryLog];
  }

  /** Log entries still inside the retention window. */
  retainedQueryLog(nowMs: number): QueryLogEntry[] {
    return this.queryLog.filter((e) => nowMs - e.atMs <= QUERY_LOG_RETENTION_MS);
  }
}

// ================================================= cohort & retention

export interface CohortMember {
  customerId: string;
  /** The period index the customer joined in. */
  cohortPeriod: number;
  /** Period indices in which the customer was active. */
  activePeriods: number[];
}

export interface RetentionCell {
  cohortPeriod: number;
  periodsSinceJoin: number;
  cohortSize: number;
  retained: number;
  retentionRate: number;
}

/**
 * OUTPUTS: a cohort retention matrix.
 *
 * Period zero is always 100% by construction — a customer is active in the period they joined — so
 * it is emitted rather than suppressed, because an analyst comparing cohorts needs the denominator
 * visible. A cell for a period a cohort has not yet reached is OMITTED rather than shown as zero:
 * a cohort that joined last month has not failed to retain at month six, it simply has not got
 * there, and a zero would read as catastrophic churn.
 */
export function retentionMatrix(members: CohortMember[], periodsObserved: number): RetentionCell[] {
  const byCohort = new Map<number, CohortMember[]>();
  for (const m of members) {
    const list = byCohort.get(m.cohortPeriod) ?? [];
    list.push(m);
    byCohort.set(m.cohortPeriod, list);
  }

  const cells: RetentionCell[] = [];
  for (const [cohortPeriod, cohort] of [...byCohort.entries()].sort((a, b) => a[0] - b[0])) {
    for (let offset = 0; offset <= periodsObserved - cohortPeriod - 1; offset++) {
      const period = cohortPeriod + offset;
      if (period >= periodsObserved) break;
      const retained = cohort.filter((m) => m.activePeriods.includes(period)).length;
      cells.push({
        cohortPeriod,
        periodsSinceJoin: offset,
        cohortSize: cohort.length,
        retained,
        retentionRate: cohort.length === 0 ? 0 : Math.round((retained / cohort.length) * 10_000) / 10_000,
      });
    }
  }
  return cells;
}

// ================================================= scheduled snapshots

export interface Snapshot {
  snapshotId: string;
  explorationId: string;
  takenAtMs: number;
  certified: boolean;
  watermark: string;
  stale: boolean;
  rowCount: number;
}

/**
 * OUTPUTS: a scheduled snapshot. It carries the badge and watermark of the exploration that
 * produced it, so a PDF read next quarter cannot be mistaken for certified data it never was.
 */
export function snapshot(snapshotId: string, result: ExplorationResult, nowMs: number): Snapshot {
  return {
    snapshotId,
    explorationId: result.explorationId,
    takenAtMs: nowMs,
    certified: result.certified,
    watermark: result.watermark,
    stale: result.stale,
    rowCount: result.rowCap,
  };
}
