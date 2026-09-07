/**
 * FR-AI-012 customer segmentation. The distinction this suite is built around is that consent
 * filters at ACTIVATION and not at analytics — a customer may legitimately be counted in a cohort
 * that no campaign may contact, and conflating the two either corrupts the analysis or leaks a
 * contact.
 */
import { describe, expect, it } from 'vitest';
import * as SegmentationModule from '../src/domain/segmentation.js';
import {
  evaluateDsl,
  SegmentRegistry,
  SENSITIVE_PROXY_FIELDS,
  validateDsl,
  validateRule,
  type CustomerFeatures,
  type SegmentDefinition,
} from '../src/domain/segmentation.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

/** The acceptance scenario's segment: gold-tier customers with no order in 90 days. */
const lapsedGold = (over: Partial<SegmentDefinition> = {}): SegmentDefinition => ({
  name: 'lapsed-90d-gold',
  version: 1,
  kind: 'RULE_BASED',
  dsl: {
    all: [
      { field: 'tier', op: 'EQ', value: 'GOLD' },
      { field: 'days_since_last_order', op: 'GTE', value: 90 },
    ],
  },
  consentGatedFields: ['marketing_email'],
  ...over,
});

const customer = (
  id: string,
  tier: string,
  daysSince: number,
  consents: Record<string, boolean> = { marketing_email: true },
): CustomerFeatures => ({
  customerId: id,
  attributes: { tier, days_since_last_order: daysSince },
  consents,
});

const registryWith = (def: SegmentDefinition = lapsedGold()) => {
  const r = new SegmentRegistry();
  const res = r.define(def);
  if (!res.ok) throw new Error('define failed: ' + JSON.stringify(res.violations));
  return r;
};

// ============================================ DSL validation

describe('the DSL rejects PII literals and PII fields (VALIDATION)', () => {
  it('rejects a raw phone number as a rule value', () => {
    const v = validateRule({ field: 'contact_hint', op: 'EQ', value: '+91 98765 43210' });
    expect(v.some((x) => x.code === 'DSL_CONTAINS_PII_LITERAL_PHONE')).toBe(true);
  });

  it('rejects an email, an Aadhaar-like and a PAN-like literal', () => {
    expect(validateRule({ field: 'hint', op: 'EQ', value: 'harish@pixoustech.com' })
      .some((x) => x.code === 'DSL_CONTAINS_PII_LITERAL_EMAIL')).toBe(true);
    expect(validateRule({ field: 'hint', op: 'EQ', value: '1234 5678 9012' })
      .some((x) => x.code === 'DSL_CONTAINS_PII_LITERAL_AADHAAR_LIKE')).toBe(true);
    expect(validateRule({ field: 'hint', op: 'EQ', value: 'ABCDE1234F' })
      .some((x) => x.code === 'DSL_CONTAINS_PII_LITERAL_PAN_LIKE')).toBe(true);
  });

  it('rejects segmenting directly on a PII field even with an innocuous value', () => {
    const v = validateRule({ field: 'mobile', op: 'NEQ', value: 'unknown' });
    expect(v.some((x) => x.code === 'DSL_REFERENCES_PII_FIELD')).toBe(true);
  });

  it('catches a PII literal hidden inside an IN list', () => {
    const v = validateRule({ field: 'hint', op: 'IN', value: ['ok', 'also@ok.com'] });
    expect(v.some((x) => x.code === 'DSL_CONTAINS_PII_LITERAL_EMAIL')).toBe(true);
  });

  it('permits ordinary behavioural rules', () => {
    expect(validateRule({ field: 'tier', op: 'EQ', value: 'GOLD' })).toEqual([]);
    expect(validateRule({ field: 'days_since_last_order', op: 'GTE', value: 90 })).toEqual([]);
    expect(validateRule({ field: 'city', op: 'IN', value: ['Coimbatore', 'Chennai'] })).toEqual([]);
  });

  it('enforces operator and value-shape agreement', () => {
    expect(validateRule({ field: 'tier', op: 'IN', value: 'GOLD' })
      .some((x) => x.code === 'IN_REQUIRES_A_LIST')).toBe(true);
    expect(validateRule({ field: 'tier', op: 'EQ', value: ['GOLD', 'SILVER'] })
      .some((x) => x.code === 'ONLY_IN_ACCEPTS_A_LIST')).toBe(true);
  });

  it('a rule-based segment needs a non-empty DSL', () => {
    expect(validateDsl(undefined).some((x) => x.code === 'DSL_REQUIRED_FOR_RULE_BASED_SEGMENT')).toBe(true);
    expect(validateDsl({}).some((x) => x.code === 'DSL_HAS_NO_RULES')).toBe(true);
    expect(validateDsl({ all: [] }).some((x) => x.code === 'DSL_HAS_NO_RULES')).toBe(true);
  });

  it('a definition carrying a PII literal is refused outright', () => {
    const r = new SegmentRegistry();
    const res = r.define(lapsedGold({
      dsl: { all: [{ field: 'hint', op: 'EQ', value: 'harish@pixoustech.com' }] },
    }));
    expect(res.ok).toBe(false);
    expect(r.definition('lapsed-90d-gold')).toBeUndefined();
  });
});

// ============================================ DSL evaluation

describe('DSL evaluation', () => {
  const dsl = lapsedGold().dsl!;

  it('requires every rule in `all` to match', () => {
    expect(evaluateDsl(dsl, customer('C1', 'GOLD', 120))).toBe(true);
    expect(evaluateDsl(dsl, customer('C2', 'SILVER', 120))).toBe(false);
    expect(evaluateDsl(dsl, customer('C3', 'GOLD', 30))).toBe(false);
  });

  it('requires at least one rule in `any` to match when present', () => {
    const withAny = {
      all: [{ field: 'tier', op: 'EQ' as const, value: 'GOLD' }],
      any: [
        { field: 'days_since_last_order', op: 'GTE' as const, value: 90 },
        { field: 'days_since_last_order', op: 'LTE' as const, value: 2 },
      ],
    };
    expect(evaluateDsl(withAny, customer('C1', 'GOLD', 120))).toBe(true);
    expect(evaluateDsl(withAny, customer('C2', 'GOLD', 1))).toBe(true);
    expect(evaluateDsl(withAny, customer('C3', 'GOLD', 40))).toBe(false);
  });

  it('a missing attribute never matches rather than defaulting', () => {
    const missing: CustomerFeatures = { customerId: 'C9', attributes: {}, consents: {} };
    expect(evaluateDsl(dsl, missing)).toBe(false);
  });

  it('numeric operators refuse to compare non-numbers', () => {
    const c: CustomerFeatures = {
      customerId: 'C1', attributes: { tier: 'GOLD', days_since_last_order: 'many' }, consents: {},
    };
    expect(evaluateDsl(dsl, c)).toBe(false);
  });

  it('the boundary is inclusive for GTE', () => {
    expect(evaluateDsl(dsl, customer('C1', 'GOLD', 90))).toBe(true);
    expect(evaluateDsl(dsl, customer('C2', 'GOLD', 89))).toBe(false);
  });
});

// ============================================ duplicate names

describe('definition conflicts are blocked (ERRORS)', () => {
  it('a duplicate name at the same or lower version is refused', () => {
    const r = registryWith();
    const same = r.define(lapsedGold({ version: 1 }));
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.violations.some((v) => v.code === 'DUPLICATE_SEGMENT_NAME')).toBe(true);

    expect(r.define(lapsedGold({ version: 0 })).ok).toBe(false);
  });

  it('a higher version of the same name is the sanctioned route', () => {
    const r = registryWith();
    expect(r.define(lapsedGold({ version: 2 })).ok).toBe(true);
    expect(r.definition('lapsed-90d-gold')!.version).toBe(2);
  });

  it('a redefinition drops any prior activation, since the sign-off applied to the old form', () => {
    const r = registryWith();
    r.activate('lapsed-90d-gold');
    expect(r.isActivated('lapsed-90d-gold')).toBe(true);
    r.define(lapsedGold({ version: 2 }));
    expect(r.isActivated('lapsed-90d-gold')).toBe(false);
  });

  it('segment names are constrained to a safe slug form', () => {
    const r = new SegmentRegistry();
    expect(r.define(lapsedGold({ name: 'ab' })).ok).toBe(false);
    expect(r.define(lapsedGold({ name: 'Lapsed Gold!' })).ok).toBe(false);
    expect(r.define(lapsedGold({ name: 'lapsed-90d-gold' })).ok).toBe(true);
  });
});

// ============================================ descriptor sign-off

describe('model clusters require descriptor sign-off before activation (VALIDATION)', () => {
  const modelSegment = (over: Partial<SegmentDefinition> = {}): SegmentDefinition => ({
    name: 'cluster-bargain-hunters',
    version: 1,
    kind: 'MODEL_BASED',
    clusterDescriptor: 'Customers who buy predominantly during discount events and rarely at full price',
    consentGatedFields: ['marketing_email'],
    ...over,
  });

  it('a model segment needs a human-readable descriptor at definition time', () => {
    const r = new SegmentRegistry();
    const noDescriptor = r.define(modelSegment({ clusterDescriptor: undefined }));
    expect(noDescriptor.ok).toBe(false);
    if (!noDescriptor.ok) {
      expect(noDescriptor.violations.some((v) =>
        v.code === 'MODEL_SEGMENT_REQUIRES_HUMAN_READABLE_DESCRIPTOR')).toBe(true);
    }
    expect(r.define(modelSegment({ clusterDescriptor: 'cluster 7' })).ok).toBe(false);
    expect(r.define(modelSegment()).ok).toBe(true);
  });

  it('activation is refused without a sign-off reference', () => {
    const r = registryWith(modelSegment());
    const res = r.activate('cluster-bargain-hunters');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('MODEL_CLUSTER_REQUIRES_DESCRIPTOR_SIGN_OFF_BEFORE_ACTIVATION');
    expect(r.isActivated('cluster-bargain-hunters')).toBe(false);
  });

  it('activation succeeds once the descriptor is signed off', () => {
    const r = registryWith(modelSegment({ descriptorSignOffRef: 'DECISION-LOG-D-031' }));
    expect(r.activate('cluster-bargain-hunters').ok).toBe(true);
  });

  it('a rule-based segment needs no sign-off, because its meaning is its rules', () => {
    expect(registryWith().activate('lapsed-90d-gold').ok).toBe(true);
  });

  it('activating an unknown segment is refused', () => {
    expect(new SegmentRegistry().activate('nope').ok).toBe(false);
  });
});

// ============================================ the acceptance scenario

describe('the documented acceptance scenario: refreshing lapsed-90d-gold yields a delta report', () => {
  it('lists additions and removals between refreshes', () => {
    const r = registryWith();

    // first refresh: C1 and C2 qualify
    const day1 = [customer('C1', 'GOLD', 100), customer('C2', 'GOLD', 95), customer('C3', 'GOLD', 10)];
    const first = r.refresh('lapsed-90d-gold', day1, NOW);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.membership.customerIds).toEqual(['C1', 'C2']);

    // second refresh: C2 has bought again (so drops out), C3 has now lapsed (so joins)
    const day2 = [customer('C1', 'GOLD', 130), customer('C2', 'GOLD', 3), customer('C3', 'GOLD', 91)];
    const second = r.refresh('lapsed-90d-gold', day2, NOW + 86_400_000);
    expect(second.ok).toBe(true);

    const delta = r.delta('lapsed-90d-gold')!;
    expect(delta.segmentName).toBe('lapsed-90d-gold');
    expect(delta.added).toEqual(['C3']);
    expect(delta.removed).toEqual(['C2']);
    expect(delta.retained).toBe(1);
    expect(delta.previousCount).toBe(2);
    expect(delta.currentCount).toBe(2);
  });

  it('a first refresh reports every member as an addition, not as a mystery', () => {
    const r = registryWith();
    r.refresh('lapsed-90d-gold', [customer('C1', 'GOLD', 100)], NOW);
    const delta = r.delta('lapsed-90d-gold')!;
    expect(delta.added).toEqual(['C1']);
    expect(delta.removed).toEqual([]);
    expect(delta.previousCount).toBe(0);
  });

  it('membership is sorted so a delta is stable rather than order-dependent', () => {
    const r = registryWith();
    const res = r.refresh('lapsed-90d-gold',
      [customer('C9', 'GOLD', 100), customer('C1', 'GOLD', 100)], NOW);
    if (res.ok) expect(res.membership.customerIds).toEqual(['C1', 'C9']);
  });

  it('no delta exists for a segment never refreshed', () => {
    expect(registryWith().delta('lapsed-90d-gold')).toBeUndefined();
  });
});

// ============================================ consent at activation only

describe('consent auto-filters at ACTIVATION, not at analytics (RULES)', () => {
  const population = () => [
    customer('C1', 'GOLD', 100, { marketing_email: true }),
    customer('C2', 'GOLD', 100, { marketing_email: false }),
    customer('C3', 'GOLD', 100, {}),
  ];

  it('analytics counts every member, including those who refused contact', () => {
    const r = registryWith();
    r.refresh('lapsed-90d-gold', population(), NOW);
    const m = r.membershipForAnalytics('lapsed-90d-gold', '01ANALYST', NOW)!;
    expect(m.count).toBe(3);
    expect(m.customerIds).toEqual(['C1', 'C2', 'C3']);
  });

  it('activation filters out members lacking the gated consent', () => {
    const r = registryWith();
    r.activate('lapsed-90d-gold');
    r.refresh('lapsed-90d-gold', population(), NOW);

    const res = r.membershipForActivation('lapsed-90d-gold', population(), '01MKT', NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.membership.customerIds).toEqual(['C1']);
    expect(res.membership.count).toBe(1);
    expect(res.filteredOut.sort()).toEqual(['C2', 'C3']);
  });

  it('a missing consent key is treated as absent consent rather than as permission', () => {
    const r = registryWith();
    r.activate('lapsed-90d-gold');
    r.refresh('lapsed-90d-gold', [customer('C3', 'GOLD', 100, {})], NOW);
    const res = r.membershipForActivation('lapsed-90d-gold', [customer('C3', 'GOLD', 100, {})], '01MKT', NOW);
    if (res.ok) expect(res.membership.count).toBe(0);
  });

  it('a member absent from the supplied population is filtered out, never assumed consenting', () => {
    const r = registryWith();
    r.activate('lapsed-90d-gold');
    r.refresh('lapsed-90d-gold', population(), NOW);
    const res = r.membershipForActivation('lapsed-90d-gold', [], '01MKT', NOW);
    if (res.ok) {
      expect(res.membership.count).toBe(0);
      expect(res.filteredOut).toHaveLength(3);
    }
  });

  it('activation is refused for a segment that was never activated or never refreshed', () => {
    const notActivated = registryWith();
    notActivated.refresh('lapsed-90d-gold', population(), NOW);
    const a = notActivated.membershipForActivation('lapsed-90d-gold', population(), '01MKT', NOW);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe('SEGMENT_NOT_ACTIVATED');

    const notRefreshed = registryWith();
    notRefreshed.activate('lapsed-90d-gold');
    const b = notRefreshed.membershipForActivation('lapsed-90d-gold', population(), '01MKT', NOW);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('SEGMENT_NEVER_REFRESHED');
  });

  it('a segment with no gated fields activates against everyone in it', () => {
    const r = registryWith(lapsedGold({ consentGatedFields: [] }));
    r.activate('lapsed-90d-gold');
    r.refresh('lapsed-90d-gold', population(), NOW);
    const res = r.membershipForActivation('lapsed-90d-gold', population(), '01MKT', NOW);
    if (res.ok) expect(res.membership.count).toBe(3);
  });
});

// ============================================ staleness

describe('refresh failure keeps the last-good set and flags it (ERRORS)', () => {
  it('marks stale rather than emptying the segment', () => {
    const r = registryWith();
    r.refresh('lapsed-90d-gold', [customer('C1', 'GOLD', 100)], NOW);
    const stale = r.markStale('lapsed-90d-gold', NOW + 3_600_000)!;
    expect(stale.stale).toBe(true);
    expect(stale.staleSinceMs).toBe(NOW + 3_600_000);
    expect(stale.customerIds).toEqual(['C1']);
    // an empty segment silently stops a campaign; a stale one announces itself
    expect(stale.count).toBe(1);
  });

  it('a successful refresh clears the staleness flag', () => {
    const r = registryWith();
    r.refresh('lapsed-90d-gold', [customer('C1', 'GOLD', 100)], NOW);
    r.markStale('lapsed-90d-gold', NOW + 1000);
    const again = r.refresh('lapsed-90d-gold', [customer('C1', 'GOLD', 105)], NOW + 2000);
    if (again.ok) expect(again.membership.stale).toBe(false);
  });

  it('marking a never-refreshed segment stale yields nothing to flag', () => {
    expect(registryWith().markStale('lapsed-90d-gold', NOW)).toBeUndefined();
  });
});

// ============================================ overlap & fairness

describe('overlap analysis (OUTPUTS)', () => {
  it('reports shared, exclusive and Jaccard figures', () => {
    const r = new SegmentRegistry();
    r.define(lapsedGold());
    r.define(lapsedGold({ name: 'gold-tier', dsl: { all: [{ field: 'tier', op: 'EQ', value: 'GOLD' }] } }));
    const pop = [customer('C1', 'GOLD', 100), customer('C2', 'GOLD', 10), customer('C3', 'SILVER', 100)];
    r.refresh('lapsed-90d-gold', pop, NOW);
    r.refresh('gold-tier', pop, NOW);

    const o = r.overlap('lapsed-90d-gold', 'gold-tier')!;
    expect(o.shared).toBe(1);      // C1
    expect(o.onlyA).toBe(0);
    expect(o.onlyB).toBe(1);       // C2
    expect(o.jaccard).toBe(0.5);
  });

  it('overlap is undefined when either segment is unrefreshed', () => {
    expect(registryWith().overlap('lapsed-90d-gold', 'nope')).toBeUndefined();
  });
});

describe('sensitive-attribute proxy audit (RULES)', () => {
  it('flags a geography rule, the proxy most easily defended as innocent', () => {
    const r = registryWith(lapsedGold({
      dsl: { all: [{ field: 'tier', op: 'EQ', value: 'GOLD' }, { field: 'pincode', op: 'IN', value: ['641001'] }] },
    }));
    const findings = r.proxyAudit('lapsed-90d-gold');
    expect(findings).toHaveLength(1);
    expect(findings[0].field).toBe('pincode');
    expect(findings[0].reason).toBe('FIELD_IS_OR_PROXIES_A_PROTECTED_ATTRIBUTE');
  });

  it('flags direct protected attributes and surname-style proxies', () => {
    for (const field of ['religion', 'caste', 'gender', 'surname', 'mother_tongue']) {
      expect(SENSITIVE_PROXY_FIELDS.has(field)).toBe(true);
    }
  });

  it('a purely behavioural segment produces no findings', () => {
    expect(registryWith().proxyAudit('lapsed-90d-gold')).toEqual([]);
  });
});

// ============================================ security

describe('export is disabled: activation-only (SECURITY)', () => {
  it('the module exposes no export, download or list-to-file surface', () => {
    const registryMethods = Object.getOwnPropertyNames(SegmentRegistry.prototype);
    const suspicious = registryMethods.filter((n) => {
      const l = n.toLowerCase();
      return l.includes('export') || l.includes('download') || l.includes('tocsv') || l.includes('dump');
    });
    expect(suspicious).toEqual([]);

    const moduleExports = Object.keys(SegmentationModule).filter((n) => {
      const l = n.toLowerCase();
      return l.startsWith('export') || l.includes('download') || l.includes('tocsv');
    });
    expect(moduleExports).toEqual([]);
  });

  it('membership queries are logged with purpose and actor', () => {
    const r = registryWith();
    r.activate('lapsed-90d-gold');
    const pop = [customer('C1', 'GOLD', 100)];
    r.refresh('lapsed-90d-gold', pop, NOW);

    r.membershipForAnalytics('lapsed-90d-gold', '01ANALYST', NOW + 10);
    r.membershipForActivation('lapsed-90d-gold', pop, '01MKT', NOW + 20);

    const log = r.queryLogEntries();
    expect(log).toHaveLength(2);
    expect(log[0].purpose).toBe('ANALYTICS');
    expect(log[0].actorId).toBe('01ANALYST');
    expect(log[1].purpose).toBe('ACTIVATION');
    expect(log[1].actorId).toBe('01MKT');
    expect(log[1].returnedCount).toBe(1);
  });

  it('a query against an unknown segment logs nothing rather than a phantom entry', () => {
    const r = registryWith();
    expect(r.membershipForAnalytics('nope', '01ANALYST', NOW)).toBeUndefined();
    expect(r.queryLogEntries()).toEqual([]);
  });
});
