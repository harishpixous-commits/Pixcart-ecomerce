export const meta = {
  name: 'verify-fix-angular-pages',
  description: 'Finish, verify and fix the last 55 Angular pages in small chunks (4 groups, 2 lanes), with a progress ledger',
  whenToUse: 'Completing PixCart Angular page groups to pixel and behaviour parity, resumable chunk by chunk',
  phases: [
    { title: 'Work', detail: 'finish and self-check a chunk of 1-4 pages' },
    { title: 'Verify', detail: 'independent skeptical check of the chunk: build, pixels, interactions, console' },
    { title: 'Fix', detail: 'repair what the reviewer found, then verify again (up to 2 rounds)' },
  ],
}

const BRIEF = 'C:\\Users\\haris\\Downloads\\PixCart-company\\tools\\agent-briefs\\page-brief-v3.md'

const GROUPS = {
  delivery: {
    worktree: 'C:\\Users\\haris\\Downloads\\PixCart-pg-delivery', branch: 'port/pages-delivery', port: 4215, area: 'delivery',
    role: 'partner (guest for join, register and download when signed out)', refDir: 'frontend/src/app/delivery/',
    chunks: [['home', 'join', 'register'], ['profile', 'trips-id (/delivery/trips/:id)', 'history'], ['earnings', 'notifications', 'help', 'download']],
    notes: 'The delivery partner app is used mostly on phones: compare 390x844 first, then 1366x900. The trip page is the core: live map (shared live map component in src/app/shared/map), status steps (accept, at store, picked up, out for delivery, delivered, failed, returned), proof of delivery photo/OTP, cash collection, call and navigate buttons. Home has the new-offer accept/reject flow and the online switch. Use real trip ids of the demo partner (find them through the API on 8100 as that partner).',
  },
  'seller-b': {
    worktree: 'C:\\Users\\haris\\Downloads\\PixCart-pg-seller-b', branch: 'port/pages-seller-b', port: 4216, area: 'seller',
    role: 'seller', refDir: 'frontend/src/app/seller/',
    chunks: [['products', 'products-new', 'products-id (/seller/products/:id)'], ['products-import', 'product-reports', 'payouts', 'questions'], ['returns', 'reviews', 'settings', 'warehouses']],
    notes: 'The product editor (new and edit) is the core: every field and section, category-specific required details, variants with options, image and video upload, price/MRP/GST/HSN validation messages, save as draft vs submit for review, the AI listing writer button, moderation status banners. Products import: template download, upload, validation report, confirm. Payouts: balances, statements, filters. Settings and warehouses: every form and validation message. /seller/earnings redirects to payouts.',
  },
  'admin-b': {
    worktree: 'C:\\Users\\haris\\Downloads\\PixCart-pg-admin-b', branch: 'port/pages-admin-b', port: 4217, area: 'admin',
    role: 'admin (default admin layout; spot-check one page in each other layout)', refDir: 'frontend/src/app/admin/',
    chunks: [['home (admin dashboard)', 'orders', 'orders-id'], ['payouts', 'integrations', 'notifications'], ['go-live', 'exports', 'product-page', 'product-reports'], ['delivery', 'delivery-queue', 'delivery-trips', 'delivery-trips-id'], ['delivery-zones', 'delivery-reports', 'delivery-settings']],
    notes: 'Integrations and notifications are configuration screens: every provider card and field, test buttons, saving with the password/two-step confirmation, template editors with variables and previews. Orders and order detail: filters, search, bulk actions, every status action (cancel, refund, mark delivered, payment check), invoices, timeline. Payouts: runs, CSV, marking paid. Go-live: the checklist with live ticks. Dashboard: stat cards and charts with the same tooltips. Do not run payouts or change integration keys for real; restore anything you change. Admin group A pages and src/app/admin/shared are merged and verified: reuse them.',
  },
  'admin-c': {
    worktree: 'C:\\Users\\haris\\Downloads\\PixCart-pg-admin-c', branch: 'port/pages-admin-c', port: 4218, area: 'admin',
    role: 'admin (default admin layout; spot-check one page in each other layout)', refDir: 'frontend/src/app/admin/',
    chunks: [['storefront'], ['settings', 'regional', 'staff'], ['sign-in', 'sellers', 'sellers-id'], ['products', 'products-id', 'questions'], ['reviews', 'returns', 'refunds'], ['reports', 'support', 'support-id', 'shop-assistant']],
    notes: 'Storefront and settings are the configuration heart of the admin panel: every tab and option (brand, colours, logo, themes and layout options with the live preview on phone/tablet/desktop, announcement bar, menus, footer, home sections and blocks, information pages, business details, contact and social, SEO; marketplace settings, regional/currency/languages, return windows, cancellation rules) must look and work exactly like the reference and save to the same API. Staff and roles: invite, roles with the permission matrix, two-step sign-in. Sign-in settings: every option. Sellers and products: review queues, approve/reject with reasons, documents, commission. Restore every global setting you change while testing. Admin group A pages and src/app/admin/shared are merged and verified: reuse them.',
  },
}
const LANES = [['delivery', 'seller-b'], ['admin-b', 'admin-c']]

const ROW = {
  type: 'object',
  properties: {
    page: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'missing'] },
    parity390: { type: 'string' }, parity1366: { type: 'string' }, interactions: { type: 'string' }, remaining: { type: 'string' },
  },
  required: ['page', 'status', 'parity390', 'parity1366', 'interactions', 'remaining'],
}
const WORK = {
  type: 'object',
  properties: {
    pages: { type: 'array', items: ROW }, build_ok: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
    shared_files_changed: { type: 'array', items: { type: 'string' } }, new_site_scss_classes: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['pages', 'build_ok', 'commits', 'problems'],
}
const VERIFY = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] }, build_ok: { type: 'boolean' },
    pages: { type: 'array', items: { type: 'object', properties: { page: { type: 'string' }, ok: { type: 'boolean' }, parity390: { type: 'string' }, parity1366: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['page', 'ok', 'parity390', 'parity1366', 'issues'] } },
    blocking_issues: { type: 'array', items: { type: 'string' } }, environment_problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'build_ok', 'pages', 'blocking_issues'],
}

const list = (pages) => pages.map((p) => '- ' + p).join('\n')
const where = (g) => `- Worktree: ${g.worktree} (branch ${g.branch}). The group's shared dev-server port: ${g.port}.
- Page files: PixCartWeb/src/app/${g.area}/pages/<name>.page.ts; reference pages under ${g.refDir}.
- Role for comparisons: ${g.role}.
- Group notes: ${g.notes}`

const workPrompt = (key, g, chunk, n, total) => `You are finishing chunk ${n}/${total} of the "${key}" page group of the PixCart Angular app. First read the brief at ${BRIEF} and follow it exactly (ledger, shared dev server, comparison, rules).
${where(g)}
- Your chunk:
${list(chunk)}
- State: every page of the group was written earlier (work in progress, never verified). Read \`git log --oneline -8\`, the ledger and the code first.

For EVERY page of your chunk: port whatever is missing; run ONE pixel comparison per role covering all chunk routes at 390x844 and 1366x900 (full page) and fix every real difference until each page is within 0.5% at both widths; click through every interaction on both sites with Playwright and make the Angular behaviour identical (visible result, API request, validation and toast texts); \`npx ng build\` with 0 errors; commit after each page; update the ledger. Leave the group's dev server running; close your browser.

Your final answer is the structured report for the pages of your chunk.`

const verifyPrompt = (key, g, chunk, round) => `You are an independent reviewer. Another agent claims these pages of the "${key}" group of the PixCart Angular app are complete and identical to the reference${round ? ` (after fix round ${round})` : ''}. Find every place where that is NOT true. Assume nothing; check everything yourself. Do NOT edit any file in the worktree except the ledger: write scripts, screenshots and notes in your own scratchpad folder.
First read the brief at ${BRIEF}: its parts on running, comparing and the ledger apply to you; its parts on editing code and committing do not.
${where(g)}
- Pages to check:
${list(chunk)}

Check EVERY page: (1) not a placeholder: no data-testid="placeholder-page", no TODO / "coming soon" / not-implemented text, no control without a handler; (2) \`npx ng build\` in PixCartWeb gives 0 errors (once); (3) pixel parity at 390x844 and 1366x900, full page, with real data, plus a second state where the page has one (another tab, an empty or error state, a different record) — up to 0.5% passes; above that, open the diff image and say whether it is a real difference or live data; (4) interactions: every button, form (submit empty and invalid values: validation texts must match), dialog, tab, filter, sort, pagination and upload on BOTH sites: same visible result, same API request (method, path, query, body), same toast or error text — irreversible actions (payouts, deletes, integration keys) only up to the confirmation step, comparing the request the Angular code would send by reading it; (5) console errors the reference does not also have.
Verdict "pass" only if every page passes every check. In the ledger, set status "verified" for each page that passed (with your parity numbers) and leave the others as they are. For each problem give the page, exactly what differs and the evidence (numbers, the differing request, file and line when known). Environment problems (reference down, sign-in refused) go in environment_problems. Use the group's running dev server; do not stop it. Close your browser.`

const fixPrompt = (key, g, chunk, verify, round) => `You are fixing the problems an independent reviewer found in the "${key}" page group of the PixCart Angular app (fix round ${round}). First read the brief at ${BRIEF} and follow it exactly.
${where(g)}
- Chunk pages:
${list(chunk)}
- The reviewer's findings (JSON):
${JSON.stringify({ blocking_issues: verify.blocking_issues, pages: verify.pages.filter((p) => !p.ok) }, null, 1)}

For each problem: reproduce it, fix it, then re-check that page (pixel parity at both widths and the affected interactions) to confirm the fix and that nothing else regressed. \`npx ng build\` with 0 errors; commit; update the ledger (never set "verified" yourself). If a finding is wrong (the page already matches), show the evidence in your report instead of changing code. Leave the dev server running; close your browser. Your final answer is the structured report for the pages you touched.`

async function runChunk(key, g, chunk, n, total) {
  const label = `${key}#${n}`
  const work = await agent(workPrompt(key, g, chunk, n, total), { label: `work:${label}`, phase: 'Work', schema: WORK })
  if (!work) { log(`${label}: the worker stopped without a report; resume this run later`); return { group: key, chunk: n, pages: chunk, work: null, verify: null, rounds: 0 } }
  let verify = await agent(verifyPrompt(key, g, chunk, 0), { label: `verify:${label}`, phase: 'Verify', schema: VERIFY })
  let rounds = 0
  while (verify && verify.verdict === 'fail' && rounds < 2) {
    rounds++
    const fix = await agent(fixPrompt(key, g, chunk, verify, rounds), { label: `fix:${label}:${rounds}`, phase: 'Fix', schema: WORK })
    if (!fix) break
    verify = await agent(verifyPrompt(key, g, chunk, rounds), { label: `verify:${label}:${rounds}`, phase: 'Verify', schema: VERIFY })
  }
  log(`${label}: ${verify ? verify.verdict : 'no verdict'} after ${rounds} fix round(s)`)
  return { group: key, chunk: n, pages: chunk, work, verify, rounds }
}

async function runLane(keys) {
  const out = []
  for (const key of keys) {
    const g = GROUPS[key]
    for (let i = 0; i < g.chunks.length; i++) out.push(await runChunk(key, g, g.chunks[i], i + 1, g.chunks.length))
  }
  return out
}

const lanes = await parallel(LANES.map((keys) => () => runLane(keys)))
const chunks = lanes.filter(Boolean).flat()
return chunks.map((c) => ({
  group: c.group, chunk: c.chunk, pages: c.pages, verdict: c.verify ? c.verify.verdict : 'none', rounds: c.rounds,
  failing: c.verify ? c.verify.pages.filter((p) => !p.ok).map((p) => ({ page: p.page, issues: p.issues })) : [],
  blocking: c.verify ? c.verify.blocking_issues : [], env: c.verify ? (c.verify.environment_problems || []) : [],
  commits: c.work ? c.work.commits : [],
}))
