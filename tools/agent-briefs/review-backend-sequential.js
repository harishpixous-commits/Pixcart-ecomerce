export const meta = {
  name: 'review-backend-vs-python-seq',
  description: 'Compare every Python backend module with its .NET counterpart, then adversarially verify each reported divergence',
  phases: [
    { title: 'Review', detail: 'one reviewer per backend slice: Python module vs .NET controllers/BAL/DAL' },
    { title: 'Verify', detail: 'independent skeptics try to refute each finding' },
  ],
}

const PY = 'C:\\Users\\haris\\Downloads\\pixcart-marketplace 1\\pixcart-marketplace\\backend\\app'
const NET = 'C:\\Users\\haris\\Downloads\\PixCart-company\\PixCartAPI'

const SLICES = [
  { key: 'auth-accounts', files: 'routers/auth.py, routers/admin_accounts.py, routers/staff.py, core/permissions.py, services/auth_settings.py, core/security*.py (if present), core/deps*.py (if present)' },
  { key: 'catalog-storefront', files: 'routers/catalog.py, routers/storefront.py, services/catalog.py, services/product_page.py, services/product_info.py, services/themes.py' },
  { key: 'cms-regional', files: 'services/cms.py, services/regional.py, routers/regional.py, services/translate.py, routers/admin_prefs.py' },
  { key: 'cart-checkout-orders', files: 'routers/cart.py, routers/orders.py, services/orders.py (checkout, place order, cancel, confirm, status transitions)' },
  { key: 'payments-fees-coupons', files: 'routers/webhooks.py, services/razorpay.py, routers/checkout_admin.py, services/fees.py, services/shipping.py, services/coupons.py' },
  { key: 'returns-refunds-invoices', files: 'services/returns.py, services/invoices.py, services/fee_invoices.py, services/ledger.py, services/docgen.py, and the order/return/refund/invoice parts of routers/customer.py' },
  { key: 'customer-misc', files: 'routers/customer.py (everything except orders/returns/invoices: profile, privacy/DPDP, notifications, support tickets), routers/addresses.py, services/support.py' },
  { key: 'seller-products-inventory', files: 'routers/seller_products.py, services/inventory.py, services/product_import.py' },
  { key: 'seller-orders-onboarding', files: 'routers/seller_orders.py, routers/seller_extras.py, routers/seller_onboarding.py' },
  { key: 'delivery-fleet', files: 'services/fleet.py, routers/delivery.py, services/delivery.py, services/delivery_settings.py, services/push.py, routers/push.py' },
  { key: 'delivery-admin', files: 'routers/delivery_admin.py (with the services/fleet.py functions it calls)' },
  { key: 'admin-ops', files: 'routers/admin.py' },
  { key: 'admin-extras', files: 'routers/admin_extras.py, routers/admin_search.py' },
  { key: 'exports-reports-integrations', files: 'routers/exports.py, services/exports.py, services/reports.py, services/stats.py, services/analytics.py, routers/integrations.py, integrations/registry.py, integrations/store.py, integrations/checks.py' },
  { key: 'promotions-ads-engagement', files: 'routers/promotions.py, services/ads.py, services/deals.py, routers/engagement.py, services/engagement.py, services/review_settings.py' },
  { key: 'notify-jobs-settings', files: 'services/notify.py, services/sms.py, jobs.py, services/platform_settings.py, services/storage.py' },
  { key: 'assistant-core', files: 'assistant/tools.py, assistant/queries.py, assistant/decision.py, assistant/agent.py, assistant/sandbox.py, assistant/periods.py, assistant/prompts.py' },
  { key: 'assistant-actions-files', files: 'assistant/actions.py, assistant/uploads.py, assistant/downloads.py, assistant/settings.py, routers/assistant.py' },
  { key: 'shop-assistant', files: 'shop_assistant/*.py, routers/shop_assistant.py, routers/admin_shop_assistant.py' },
  { key: 'llm-ai', files: 'llm/*.py, ai/*.py, routers/ai.py' },
]

const COMMON = `
PixCart is a multi-seller marketplace. The Python/FastAPI backend is the live product and the source of truth for behaviour:
  ${PY}   (read-only; never modify it)
The ASP.NET Core .NET 10 backend must behave identically (same routes, inputs, outputs, errors, side effects):
  ${NET}  (API/Controllers -> BAL -> DAL with Dapper SQL; MySQL 8.4 instead of PostgreSQL)
Much of the .NET code was written quickly by another agent and only partly exercised. Your job: find places where the
.NET code behaves differently from the Python code, or is simply wrong.

How to work:
- For every route and service function in your slice, find the .NET counterpart: grep the route path (for example
  "admin/orders") in ${NET}\\API\\Controllers, then follow the calls into BAL and DAL. Read both sides fully.
- Compare behaviour: which inputs are accepted or refused and with which HTTP status, error code and message;
  permission and ownership checks; state transitions; money arithmetic (integer paise, rounding, GST/TCS/TDS, fees,
  commissions, refunds, payouts); stock and inventory side effects; notifications, audit rows and other side effects;
  transaction boundaries and row locking (FOR UPDATE); idempotency and duplicate handling; time zones (IST display,
  UTC storage); pagination, sorting and filter semantics; what background jobs do; JSON shape of responses.
- Request body/query validation (pydantic constraints) and route-level sign-in/permission rules are enforced centrally in
  .NET by API/Infrastructure/BodyRulesFilter.cs, QueryRulesFilter.cs and RouteGuardFilter.cs from JSON rules generated
  from the Python OpenAPI schema, and a differential test already matched 119/119 validation cases; times are formatted
  centrally by ApiJsonFilter. Differences there are unlikely: focus on business logic inside handlers and services.
- Read and grep only. Do NOT edit files. Do NOT run builds, tests, servers, databases, or any git command that changes
  anything (git log/show/grep are fine).

Do NOT report (accepted or irrelevant):
- comment wording, naming, code style, log text, performance that does not change results;
- row order where Python has no ORDER BY or sorts with ties (facet ties, deal variants, staff roles) or relies on
  PostgreSQL plan order;
- daily figures computed in UTC days (production database runs in UTC);
- reworded texts of Python's own runtime exceptions (int() parsing), integration setup hints naming ASP.NET Core;
- random identifiers (order numbers, return numbers, tokens) differing in value;
- live AI/LLM and payment/SMS provider calls being mocked or sandboxed in this environment;
- MySQL equivalents of PostgreSQL features that produce the same observable result.

Every finding needs: the exact Python file:line and .NET file:line, and a concrete failure scenario (inputs and state,
what Python returns or does, what .NET returns or does). Prefer fewer real findings over many speculative ones. If you
cannot point at the exact .NET line that diverges, it is not a finding. An empty list is a fine answer for a clean slice.
`

const FINDINGS = {
  type: 'object',
  properties: {
    slice: { type: 'string' },
    routes_and_functions_checked: { type: 'number' },
    dotnet_files_read: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['money', 'state', 'permission', 'validation', 'side-effect', 'data-shape', 'error-text', 'concurrency', 'missing-behaviour', 'other'] },
          python_ref: { type: 'string' },
          dotnet_ref: { type: 'string' },
          failure_scenario: { type: 'string' },
          python_behaviour: { type: 'string' },
          dotnet_behaviour: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'python_ref', 'dotnet_ref', 'failure_scenario', 'python_behaviour', 'dotnet_behaviour', 'suggested_fix'],
      },
    },
  },
  required: ['slice', 'routes_and_functions_checked', 'findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reasoning: { type: 'string' },
    exact_dotnet_location: { type: 'string' },
    corrected_fix: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'reasoning'],
}

function verifyPrompt(f, slice, lens) {
  return `You are an independent skeptic. Another reviewer claims the .NET backend diverges from the Python backend.
${COMMON}
The claim (slice ${slice}):
- Title: ${f.title}
- Severity/category: ${f.severity} / ${f.category}
- Python: ${f.python_ref}
- .NET: ${f.dotnet_ref}
- Scenario: ${f.failure_scenario}
- Python behaviour: ${f.python_behaviour}
- .NET behaviour: ${f.dotnet_behaviour}
- Suggested fix: ${f.suggested_fix}

Your lens: ${lens}
Try hard to REFUTE the claim. Read the cited code on both sides and everything it calls: maybe .NET handles the case
elsewhere (a central filter, a caller, a DAL query, a background job), maybe the Python code behaves differently than
claimed, maybe the scenario cannot happen with real data. Verdict "confirmed" only if you traced both code paths and
the scenario really produces a different observable result (response, stored data, side effect). If unsure, "refuted".
If confirmed, give the exact .NET location to change and the most precise fix (corrected_fix).`
}

// one slice at a time (each finished review is saved in the run journal, so a usage limit costs at most one slice)
const results = []
for (const s of SLICES) {
  const review = await agent(`Review slice "${s.key}" of the PixCart backend.
${COMMON}
Your slice (paths relative to ${PY}): ${s.files}
Set "slice" to "${s.key}".`,
    { label: `review:${s.key}`, phase: 'Review', schema: FINDINGS })
  if (!review || !review.findings) { results.push({ slice: s.key, review: null, verified: [] }); continue }
  const verified = await parallel(review.findings.map((f) => async () => {
    const lenses = f.severity === 'critical'
      ? ['trace the exact code paths line by line on both sides', 'look for where the .NET code (filters, callers, jobs, SQL) might already handle this']
      : ['trace the exact code paths line by line on both sides, and check whether the .NET code handles it elsewhere']
    const votes = (await parallel(lenses.map((lens, i) => () =>
      agent(verifyPrompt(f, s.key, lens), { label: `verify:${s.key}:${f.title.slice(0, 40)}${i ? ':2' : ''}`, phase: 'Verify', schema: VERDICT })))).filter(Boolean)
    const confirmed = votes.length > 0 && votes.every((v) => v.verdict === 'confirmed')
    return { ...f, slice: s.key, confirmed, votes }
  }))
  results.push({ slice: s.key, checked: review.routes_and_functions_checked, files: review.dotnet_files_read, verified: verified.filter(Boolean) })
  log(`${s.key}: ${review.findings.length} reported, ${verified.filter((f) => f && f.confirmed).length} confirmed`)
}

const all = results.filter(Boolean)
const confirmed = all.flatMap((r) => r.verified.filter((f) => f.confirmed))
const refuted = all.flatMap((r) => r.verified.filter((f) => !f.confirmed))
const missing = SLICES.filter((s) => !all.find((r) => r.slice === s.key && r.review !== null && r.verified !== undefined)).map((s) => s.key)
log(`confirmed ${confirmed.length}, refuted ${refuted.length}; slices without a review: ${missing.join(', ') || 'none'}`)
return {
  per_slice: all.map((r) => ({ slice: r.slice, checked: r.checked, reported: r.verified.length, confirmed: r.verified.filter((f) => f.confirmed).length })),
  confirmed: confirmed.map((f) => ({ slice: f.slice, title: f.title, severity: f.severity, category: f.category, python_ref: f.python_ref,
    dotnet_ref: f.dotnet_ref, failure_scenario: f.failure_scenario, python_behaviour: f.python_behaviour, dotnet_behaviour: f.dotnet_behaviour,
    fix: (f.votes.find((v) => v.corrected_fix) || {}).corrected_fix || f.suggested_fix, location: (f.votes.find((v) => v.exact_dotnet_location) || {}).exact_dotnet_location || f.dotnet_ref })),
  refuted: refuted.map((f) => ({ slice: f.slice, title: f.title, why: f.votes.map((v) => v.reasoning).join(' | ').slice(0, 600) })),
  slices_without_review: missing,
}
