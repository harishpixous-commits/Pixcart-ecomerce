/**
 * Customer segmentation service — FR-AI-012.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "maintain governed segments — rule-based (declarative DSL) and model-based
 *                (behavioural clusters with human-readable descriptors) — refreshed daily and
 *                on-event, activatable across campaigns, personalisation and analytics with
 *                membership audit."
 *   OUTPUTS:    "Membership sets with counts & change-logs, overlap analysis, activation APIs
 *                (consent-filtered), segment health (drift of cluster meaning)."
 *   VALIDATION: "DSL validated (no PII literals like raw phone); model clusters require
 *                descriptor sign-off before activation."
 *   RULES:      "Sensitive-attribute proxies audited quarterly (fairness review); segments
 *                referencing consent-gated data auto-filter at activation."
 *   ERRORS:     "Refresh failure → last-good with staleness flag; definition conflicts
 *                (duplicate names) blocked."
 *   SECURITY:   "Membership queries logged; export disabled (activation-only, matches
 *                FR-MKT-002)."
 *   ACCEPTANCE: "Given segment 'lapsed-90d-gold', When refreshed, Then membership delta report
 *                lists [additions and removals]."
 *
 * The distinction the requirement draws, and which this module encodes, is that consent filters at
 * ACTIVATION rather than at definition. Analytics may legitimately count a customer that a
 * campaign may not contact — conflating the two either corrupts the analysis or leaks a contact,
 * so membership is exposed through two deliberately separate methods and the activation one is the
 * only one that filters.
 *
 * "Export disabled (activation-only)" is structural: there is no export, download or toList
 * surface on this module at all, asserted by reflection. A segment that can be exported becomes a
 * marketing list living outside the platform's consent controls, which is precisely what
 * activation-only prevents.
 */

export type SegmentKind = 'RULE_BASED' | 'MODEL_BASED';

export type Operator = 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN';

export interface Rule {
  field: string;
  op: Operator;
  value: string | number | Array<string | number>;
}

/** The declarative DSL: a conjunction of rules, optionally with a disjunctive group. */
export interface SegmentDsl {
  all?: Rule[];
  any?: Rule[];
}

export interface SegmentDefinition {
  name: string;
  version: number;
  kind: SegmentKind;
  /** Required for RULE_BASED. */
  dsl?: SegmentDsl;
  /** Required for MODEL_BASED — the human-readable cluster meaning. */
  clusterDescriptor?: string;
  /** VALIDATION: model clusters need this before they may be activated. */
  descriptorSignOffRef?: string;
  /** Consent keys a member must hold for this segment to be activated against them. */
  consentGatedFields: string[];
}

export interface CustomerFeatures {
  customerId: string;
  attributes: Record<string, string | number>;
  /** Consent keys the customer has granted. */
  consents: Record<string, boolean>;
  /** For MODEL_BASED segments: the cluster the model assigned. */
  clusterId?: string;
}

/**
 * VALIDATION: PII literals must never appear in a segment definition. A rule reading
 * `mobile EQ "+919876543210"` is an audience of one, expressed as a segment — which defeats the
 * governance the DSL exists to provide and puts a phone number in a definition that gets copied
 * into dashboards and tickets.
 *
 * Order matters: the specific, highly sensitive identifiers are tested BEFORE the general phone
 * pattern, which would otherwise swallow a 12-digit Aadhaar and report it as a phone number.
 * Understating what was found would send whoever reads the violation looking for the wrong thing.
 */
const PII_LITERAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AADHAAR_LIKE', re: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { name: 'PAN_LIKE', re: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { name: 'EMAIL', re: /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/u },
  { name: 'PHONE', re: /(?:\+?\d[\d\s-]{8,}\d)/ },
];

/** Fields that are, or proxy for, protected attributes. RULES: audited for fairness. */
export const SENSITIVE_PROXY_FIELDS: ReadonlySet<string> = new Set([
  'religion', 'caste', 'ethnicity', 'gender', 'surname', 'family_name', 'community',
  'mother_tongue', 'pincode', 'postal_code', 'area_name',
]);

/** Fields that are PII regardless of value, so must not be segmented on directly. */
const PII_FIELDS: ReadonlySet<string> = new Set([
  'mobile', 'phone', 'email', 'aadhaar', 'pan', 'address_line1', 'address_line2',
]);

export interface Violation {
  code: string;
  detail: string;
}

export type DefineResult =
  | { ok: true; definition: SegmentDefinition }
  | { ok: false; violations: Violation[] };

export type ActivateResult = { ok: true } | { ok: false; reason: string };

/** OUTPUTS: a membership set with its provenance. */
export interface Membership {
  segmentName: string;
  version: number;
  customerIds: string[];
  count: number;
  refreshedAtMs: number;
  /** ERRORS: true when this is last-good data after a failed refresh. */
  stale: boolean;
  staleSinceMs?: number;
}

/** ACCEPTANCE: the membership delta report. */
export interface MembershipDelta {
  segmentName: string;
  added: string[];
  removed: string[];
  retained: number;
  previousCount: number;
  currentCount: number;
}

/** RULES: the quarterly fairness review's finding for one definition. */
export interface ProxyAuditFinding {
  segmentName: string;
  field: string;
  reason: string;
}

/** SECURITY: membership queries are logged. */
export interface QueryLogEntry {
  atMs: number;
  segmentName: string;
  purpose: 'ANALYTICS' | 'ACTIVATION';
  actorId: string;
  returnedCount: number;
}

function literalStrings(value: Rule['value']): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/** VALIDATION: validate one rule for PII literals and PII fields. */
export function validateRule(rule: Rule): Violation[] {
  const out: Violation[] = [];
  if (!rule.field || rule.field.trim().length === 0) {
    out.push({ code: 'RULE_FIELD_REQUIRED', detail: JSON.stringify(rule) });
    return out;
  }
  if (PII_FIELDS.has(rule.field.toLowerCase())) {
    out.push({ code: 'DSL_REFERENCES_PII_FIELD', detail: rule.field });
  }
  for (const literal of literalStrings(rule.value)) {
    for (const p of PII_LITERAL_PATTERNS) {
      if (p.re.test(literal)) {
        out.push({ code: `DSL_CONTAINS_PII_LITERAL_${p.name}`, detail: rule.field });
        break;
      }
    }
  }
  if (rule.op === 'IN' && !Array.isArray(rule.value)) {
    out.push({ code: 'IN_REQUIRES_A_LIST', detail: rule.field });
  }
  if (rule.op !== 'IN' && Array.isArray(rule.value)) {
    out.push({ code: 'ONLY_IN_ACCEPTS_A_LIST', detail: rule.field });
  }
  return out;
}

export function validateDsl(dsl: SegmentDsl | undefined): Violation[] {
  if (!dsl) return [{ code: 'DSL_REQUIRED_FOR_RULE_BASED_SEGMENT', detail: '' }];
  const rules = [...(dsl.all ?? []), ...(dsl.any ?? [])];
  if (rules.length === 0) return [{ code: 'DSL_HAS_NO_RULES', detail: '' }];
  return rules.flatMap(validateRule);
}

function matches(rule: Rule, features: CustomerFeatures): boolean {
  const actual = features.attributes[rule.field];
  if (actual === undefined) return false;
  switch (rule.op) {
    case 'EQ': return actual === rule.value;
    case 'NEQ': return actual !== rule.value;
    case 'GT': return typeof actual === 'number' && typeof rule.value === 'number' && actual > rule.value;
    case 'GTE': return typeof actual === 'number' && typeof rule.value === 'number' && actual >= rule.value;
    case 'LT': return typeof actual === 'number' && typeof rule.value === 'number' && actual < rule.value;
    case 'LTE': return typeof actual === 'number' && typeof rule.value === 'number' && actual <= rule.value;
    case 'IN': return Array.isArray(rule.value) && rule.value.includes(actual);
  }
}

export function evaluateDsl(dsl: SegmentDsl, features: CustomerFeatures): boolean {
  const all = dsl.all ?? [];
  const any = dsl.any ?? [];
  const allPass = all.every((r) => matches(r, features));
  const anyPass = any.length === 0 || any.some((r) => matches(r, features));
  return allPass && anyPass;
}

export class SegmentRegistry {
  private readonly definitions = new Map<string, SegmentDefinition>();
  private readonly activated = new Set<string>();
  private readonly memberships = new Map<string, Membership>();
  private readonly previous = new Map<string, Membership>();
  private readonly queryLog: QueryLogEntry[] = [];

  /**
   * Define a segment. ERRORS: a duplicate name is blocked outright — two segments called
   * "lapsed-90d-gold" is a governance failure, not a versioning strategy. A new VERSION of the
   * same name is the sanctioned route.
   */
  define(def: SegmentDefinition): DefineResult {
    const violations: Violation[] = [];

    if (!def.name || !/^[a-z0-9-]{3,60}$/.test(def.name)) {
      violations.push({ code: 'SEGMENT_NAME_INVALID', detail: def.name ?? '' });
    }
    if (def.version < 1) violations.push({ code: 'VERSION_MUST_BE_POSITIVE', detail: String(def.version) });

    const existing = this.definitions.get(def.name);
    if (existing && existing.version >= def.version) {
      violations.push({
        code: 'DUPLICATE_SEGMENT_NAME',
        detail: `${def.name} already exists at version ${existing.version}`,
      });
    }

    if (def.kind === 'RULE_BASED') {
      violations.push(...validateDsl(def.dsl));
    } else {
      if (!def.clusterDescriptor || def.clusterDescriptor.trim().length < 10) {
        violations.push({ code: 'MODEL_SEGMENT_REQUIRES_HUMAN_READABLE_DESCRIPTOR', detail: def.name });
      }
    }

    if (violations.length > 0) return { ok: false, violations };
    this.definitions.set(def.name, def);
    // a redefinition drops any prior activation: the sign-off applied to the old descriptor
    this.activated.delete(def.name);
    return { ok: true, definition: def };
  }

  /**
   * VALIDATION: a model-based cluster may not be activated without descriptor sign-off. The
   * descriptor is what a marketer reads when deciding whether targeting this cluster is
   * defensible, so an unsigned descriptor means nobody has taken responsibility for that meaning.
   */
  activate(name: string): ActivateResult {
    const def = this.definitions.get(name);
    if (!def) return { ok: false, reason: 'UNKNOWN_SEGMENT' };
    if (def.kind === 'MODEL_BASED') {
      if (!def.descriptorSignOffRef || def.descriptorSignOffRef.trim().length === 0) {
        return { ok: false, reason: 'MODEL_CLUSTER_REQUIRES_DESCRIPTOR_SIGN_OFF_BEFORE_ACTIVATION' };
      }
    }
    this.activated.add(name);
    return { ok: true };
  }

  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  definition(name: string): SegmentDefinition | undefined {
    return this.definitions.get(name);
  }

  /**
   * Refresh membership. ERRORS: on failure the last-good set is retained and flagged stale rather
   * than the segment emptying — an empty segment silently stops a campaign, whereas a stale one
   * announces itself.
   */
  refresh(name: string, population: CustomerFeatures[], nowMs: number):
    { ok: true; membership: Membership } | { ok: false; reason: string; membership?: Membership } {
    const def = this.definitions.get(name);
    if (!def) return { ok: false, reason: 'UNKNOWN_SEGMENT' };

    let ids: string[];
    try {
      if (def.kind === 'RULE_BASED') {
        ids = population.filter((c) => evaluateDsl(def.dsl!, c)).map((c) => c.customerId);
      } else {
        ids = population.filter((c) => c.clusterId === name).map((c) => c.customerId);
      }
    } catch {
      return { ok: false, reason: 'REFRESH_FAILED', membership: this.markStale(name, nowMs) };
    }

    const current = this.memberships.get(name);
    if (current) this.previous.set(name, current);
    const membership: Membership = {
      segmentName: name, version: def.version, customerIds: [...ids].sort(),
      count: ids.length, refreshedAtMs: nowMs, stale: false,
    };
    this.memberships.set(name, membership);
    return { ok: true, membership };
  }

  /** ERRORS: an upstream failure marks the last-good set stale instead of discarding it. */
  markStale(name: string, nowMs: number): Membership | undefined {
    const current = this.memberships.get(name);
    if (!current) return undefined;
    const stale: Membership = { ...current, stale: true, staleSinceMs: nowMs };
    this.memberships.set(name, stale);
    return stale;
  }

  /**
   * Membership for ANALYTICS. Not consent-filtered, deliberately: excluding non-consenting
   * customers from a count would misstate the size of the cohort being analysed.
   */
  membershipForAnalytics(name: string, actorId: string, nowMs: number): Membership | undefined {
    const m = this.memberships.get(name);
    if (m) {
      this.queryLog.push({
        atMs: nowMs, segmentName: name, purpose: 'ANALYTICS', actorId, returnedCount: m.count,
      });
    }
    return m;
  }

  /**
   * RULES: membership for ACTIVATION, auto-filtered against the consent-gated fields the segment
   * references. This is the only path a campaign may use, and the filter is applied here rather
   * than trusted to the caller.
   */
  membershipForActivation(name: string, population: CustomerFeatures[], actorId: string, nowMs: number):
    { ok: true; membership: Membership; filteredOut: string[] } | { ok: false; reason: string } {
    const def = this.definitions.get(name);
    if (!def) return { ok: false, reason: 'UNKNOWN_SEGMENT' };
    if (!this.activated.has(name)) return { ok: false, reason: 'SEGMENT_NOT_ACTIVATED' };
    const m = this.memberships.get(name);
    if (!m) return { ok: false, reason: 'SEGMENT_NEVER_REFRESHED' };

    const byId = new Map(population.map((c) => [c.customerId, c]));
    const kept: string[] = [];
    const filteredOut: string[] = [];
    for (const id of m.customerIds) {
      const c = byId.get(id);
      const consented = c !== undefined
        && def.consentGatedFields.every((key) => c.consents[key] === true);
      if (consented) kept.push(id);
      else filteredOut.push(id);
    }

    this.queryLog.push({
      atMs: nowMs, segmentName: name, purpose: 'ACTIVATION', actorId, returnedCount: kept.length,
    });
    return {
      ok: true,
      membership: { ...m, customerIds: kept, count: kept.length },
      filteredOut,
    };
  }

  /** ACCEPTANCE: the membership delta report between the last two refreshes. */
  delta(name: string): MembershipDelta | undefined {
    const current = this.memberships.get(name);
    if (!current) return undefined;
    const prev = this.previous.get(name);
    const prevIds = new Set(prev?.customerIds ?? []);
    const currIds = new Set(current.customerIds);

    const added = current.customerIds.filter((id) => !prevIds.has(id));
    const removed = (prev?.customerIds ?? []).filter((id) => !currIds.has(id));
    return {
      segmentName: name,
      added,
      removed,
      retained: current.customerIds.length - added.length,
      previousCount: prev?.count ?? 0,
      currentCount: current.count,
    };
  }

  /** OUTPUTS: overlap analysis between two segments. */
  overlap(a: string, b: string): { shared: number; onlyA: number; onlyB: number; jaccard: number } | undefined {
    const ma = this.memberships.get(a);
    const mb = this.memberships.get(b);
    if (!ma || !mb) return undefined;
    const setB = new Set(mb.customerIds);
    const shared = ma.customerIds.filter((id) => setB.has(id)).length;
    const union = new Set([...ma.customerIds, ...mb.customerIds]).size;
    return {
      shared,
      onlyA: ma.count - shared,
      onlyB: mb.count - shared,
      jaccard: union === 0 ? 0 : Math.round((shared / union) * 100) / 100,
    };
  }

  /**
   * RULES: the quarterly fairness review. Flags any field that is, or proxies for, a protected
   * attribute — including geography, which is the proxy most easily defended as innocent and most
   * reliably correlated with community in Indian cities.
   */
  proxyAudit(name: string): ProxyAuditFinding[] {
    const def = this.definitions.get(name);
    if (!def || def.kind !== 'RULE_BASED' || !def.dsl) return [];
    const rules = [...(def.dsl.all ?? []), ...(def.dsl.any ?? [])];
    const findings: ProxyAuditFinding[] = [];
    for (const r of rules) {
      if (SENSITIVE_PROXY_FIELDS.has(r.field.toLowerCase())) {
        findings.push({
          segmentName: name,
          field: r.field,
          reason: 'FIELD_IS_OR_PROXIES_A_PROTECTED_ATTRIBUTE',
        });
      }
    }
    return findings;
  }

  /** SECURITY: the membership query log. */
  queryLogEntries(): QueryLogEntry[] {
    return [...this.queryLog];
  }
}
