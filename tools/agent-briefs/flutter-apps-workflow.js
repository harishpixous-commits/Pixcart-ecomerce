export const meta = {
  name: 'flutter-apps',
  description: 'Build the three PixCart Flutter apps screen for screen like the reference mobile website, verify independently, fix',
  whenToUse: 'Completing the PixCart customer, delivery partner and seller Flutter apps to parity with the reference website on a phone',
  phases: [
    { title: 'Build', detail: 'work rounds per app until no screen is left' },
    { title: 'Verify', detail: 'independent skeptical check: analyze, tests, pixel parity at 390x844, interactions' },
    { title: 'Fix', detail: 'repair what the verifier found, then verify again (up to 2 rounds)' },
  ],
}

const BRIEF = 'C:\\Users\\haris\\pixcart-tools\\parity-kit\\flutter-brief-v2.md'

const APPS = [
  {
    key: 'partner', worktree: 'C:\\Users\\haris\\Downloads\\PixCart-fl-partner', branch: 'port/flutter-partner',
    folder: 'apps/partner_app', port: 3202, vport: 3242, phone: '7300000001',
    refDir: 'frontend/src/app/delivery/',
    screens: 'every delivery partner page of the website: home (online switch, new-offer accept/reject, current trip), join and register (KYC details and document photos), profile (bank/UPI, documents), trip detail (live map, status steps accept → at store → picked up → out for delivery → delivered / failed / returned, proof of delivery photo and OTP, cash collection, call and navigate), history, earnings, notifications, help. The website\'s app-download page is not needed inside the native app: say so instead of building it.',
    state: 'apps/partner_app contains only main.dart: build the app (router, frame, screens) on the shared packages, the way the customer app is built.',
  },
  {
    key: 'seller', worktree: 'C:\\Users\\haris\\Downloads\\PixCart-fl-seller', branch: 'port/flutter-seller',
    folder: 'apps/seller_app', port: 3203, vport: 3243, phone: '9000000001',
    refDir: 'frontend/src/app/seller/',
    screens: 'every seller hub page of the website: dashboard, onboarding, orders and order detail (confirm, pack, ship, delivered, cancel, invoice/packing slip, own-fleet hand-off), products list, product editor (new and edit: all fields, category-specific details, variants, photos and videos, validation, draft vs submit, AI listing writer), products import, product reports, inventory, payouts and earnings, analytics, coupons, deals, advertising, questions, reviews, returns, warehouses, settings, exports (downloads).',
    state: 'apps/seller_app contains only main.dart: build the app (router, frame, screens) on the shared packages, the way the customer app is built.',
  },
  {
    key: 'customer', worktree: 'C:\\Users\\haris\\Downloads\\PixCart-fl-customer', branch: 'port/flutter-customer',
    folder: 'apps/customer_app', port: 3201, vport: 3241, phone: '9999900001',
    refDir: 'frontend/src/app/(shop)/ and the other shopper pages',
    screens: 'every shopper page of the website on a phone: home, categories, category listing and search (filters, sort, paging), product page (gallery with zoom and the image/video viewer, options, delivery PIN, offers, buy box, reviews, Q&A, rails), store page, deals, coupons, compare, bestsellers and new releases, cart (save for later), checkout (addresses with PIN, delivery, coupons, fees, COD and online payment through Razorpay, saved cards), orders and order detail (payment status after the UPI app, cancel, return, invoice, tracking, rating, complaint), account (profile, addresses, saved cards, signed-in devices, privacy, delete account), wishlist, notifications, alerts, support (list, new request, ticket), help pages, contact, sign in and create account.',
    state: 'Home, categories, listing, product, cart, sign-in, account, orders, wishlist and notifications exist (check them against the reference too); checkout and the order detail screen are still placeholders; the other screens are missing.',
  },
]

const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    screens_done: { type: 'array', items: { type: 'object', properties: { screen: { type: 'string' }, parity: { type: 'string' }, notes: { type: 'string' } }, required: ['screen', 'parity', 'notes'] } },
    screens_remaining: { type: 'array', items: { type: 'string' } },
    analyze_clean: { type: 'boolean' },
    tests: { type: 'string' },
    shared_changes: { type: 'array', items: { type: 'string' } },
    commits: { type: 'array', items: { type: 'string' } },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['screens_done', 'screens_remaining', 'analyze_clean', 'tests', 'commits', 'problems'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    analyze_clean: { type: 'boolean' },
    tests: { type: 'string' },
    screens: { type: 'array', items: { type: 'object', properties: { screen: { type: 'string' }, ok: { type: 'boolean' }, parity: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['screen', 'ok', 'parity', 'issues'] } },
    missing_screens: { type: 'array', items: { type: 'string' } },
    blocking_issues: { type: 'array', items: { type: 'string' } },
    environment_problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'analyze_clean', 'tests', 'screens', 'missing_screens', 'blocking_issues'],
}

const buildPrompt = (a, round, left) => `You are building the PixCart ${a.key} app in Flutter (work round ${round}). First read the brief at ${BRIEF} and follow it exactly.
- Worktree: ${a.worktree} (branch ${a.branch}). App folder: PixCartMobile/${a.folder}. Serve your web build on port ${a.port}. Demo phone for this app: ${a.phone}.
- Reference pages: ${a.refDir}
- Screens this app must have: ${a.screens}
- State: ${round === 1 ? a.state : 'Earlier rounds finished part of the work (read git log and the code). Still remaining according to the last round: ' + JSON.stringify(left)}
Build as many remaining screens as you can, each one compared with the reference at 390x844 and its interactions checked, with widget tests, \`flutter analyze\` clean and all tests passing; commit as you go. Stop every server and browser you started before you finish. Your final answer is the structured report, with an exact list of the screens still remaining (empty only when every screen is done and verified).`

const verifyPrompt = (a, round) => `You are an independent reviewer. Other agents claim the PixCart ${a.key} Flutter app is complete and identical to the reference website on a phone${round ? ` (after fix round ${round})` : ''}. Find every place where that is NOT true. Assume nothing. Do NOT edit any file in the worktree; write scripts and outputs only in your own scratchpad folder.
First read the brief at ${BRIEF} (its running and comparing parts apply to you; editing and committing do not).
- Worktree: ${a.worktree} (branch ${a.branch}); app folder PixCartMobile/${a.folder}. Serve your own web build on port ${a.vport}. Demo phone: ${a.phone}.
- Screens the app must have: ${a.screens}
Check: every screen exists and is not a placeholder; \`flutter analyze\` is clean; every package's tests pass (run each from its own folder); pixel parity at 390x844 for every screen against the matching reference page with real data, plus a second state where one exists; every interaction (buttons, forms and their validation texts, dialogs, filters, paging, pull to refresh) gives the same result and the same API request on both. Give verdict "pass" only if everything passes. For each problem give the screen, what differs and the evidence. List missing screens separately. Report environment problems separately. Stop your servers and browsers before you finish.`

const fixPrompt = (a, verify, round) => `You are fixing what an independent reviewer found in the PixCart ${a.key} Flutter app (fix round ${round}). First read the brief at ${BRIEF} and follow it exactly.
- Worktree: ${a.worktree} (branch ${a.branch}); app folder PixCartMobile/${a.folder}; serve on port ${a.port}; demo phone ${a.phone}.
- Findings (JSON): ${JSON.stringify({ missing_screens: verify.missing_screens, blocking_issues: verify.blocking_issues, screens: verify.screens.filter(s => !s.ok) })}
For each finding: reproduce, fix, re-check that screen (parity and interactions), keep \`flutter analyze\` clean and all tests passing, commit. If a finding is wrong, give the evidence instead of changing code. Stop every server and browser you started before you finish. Final answer: the structured report.`

const results = await pipeline(
  APPS,
  async a => {
    const rounds = []
    let left = null
    for (let r = 1; r <= 4; r++) {
      const out = await agent(buildPrompt(a, r, left), { label: `build${r}:${a.key}`, phase: 'Build', schema: ROUND_SCHEMA })
      rounds.push(out)
      if (!out) { log(`${a.key}: build round ${r} stopped without a report`); break }
      left = out.screens_remaining
      log(`${a.key}: round ${r} done, ${left.length} screen(s) remaining`)
      if (left.length === 0) break
    }
    return { rounds, left }
  },
  async (built, a) => {
    if (!built.rounds.length || !built.rounds[built.rounds.length - 1]) return { app: a.key, built, verify: null, fixes: [] }
    let verify = await agent(verifyPrompt(a, 0), { label: `verify:${a.key}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    const fixes = []
    let n = 0
    while (verify && verify.verdict === 'fail' && n < 2) {
      n++
      const fix = await agent(fixPrompt(a, verify, n), { label: `fix${n}:${a.key}`, phase: 'Fix', schema: ROUND_SCHEMA })
      fixes.push(fix)
      if (!fix) break
      verify = await agent(verifyPrompt(a, n), { label: `reverify${n}:${a.key}`, phase: 'Verify', schema: VERIFY_SCHEMA })
    }
    log(`${a.key}: final verdict ${verify ? verify.verdict : 'none'}`)
    return { app: a.key, built, verify, fixes }
  },
)
return results
