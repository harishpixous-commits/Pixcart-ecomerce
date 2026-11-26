# Brief: PixCart pages in Angular, identical to the reference (v3, chunked)

## Goal
PixCart exists as a Python/Next.js site (the REFERENCE, live in production) and is rebuilt in Angular 21 + .NET 10.
Every Angular page must look identical to the reference page (pixel for pixel at 390 px and 1366 px wide) and behave
identically: every button, form, dialog, filter, sort, pagination, upload, empty state, loading skeleton, error message
and text. Nothing may stay a placeholder, a TODO, a dead button or "coming soon". You handle a small CHUNK of pages
(3 or 4) of one page group; other agents handle the other chunks one after another in the same worktree.

## Where
- Your worktree (edit only here when your role allows editing): given in your task. Angular app: `<worktree>\PixCartWeb`.
- Reference code, READ ONLY (never edit it, never run git commands that change it):
  `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\frontend\src` (Next.js app router: the URL
  `/seller/orders/[id]` lives in `app/seller/orders/[id]/page.tsx`; folders in parentheses are route groups).
  Components: `frontend/src/components`; helpers: `frontend/src/lib`; the API it calls:
  `...\pixcart-marketplace\backend\app\routers`.
- Read `<worktree>\docs\PORTING_GUIDE.md` section 3. Reuse what exists in `PixCartWeb/src/app/core`,
  `PixCartWeb/src/app/shared` and the area's `shared` folders; finished pages to learn from include
  `src/app/shop/pages/*`, `src/app/admin/pages/{customers,categories,coupons,checkout}.page.ts`,
  `src/app/seller/pages/{orders,inventory,deals}.page.ts`. Never create a second version of a component that exists.
- Each page file is already routed; keep its class name.

## The group ledger (read it first, update it last)
`<worktree>\parity-out\status.json` records every page of the group:
`{"pages": {"<page>": {"status": "verified|done|partial|missing", "parity390": "0.21%", "parity1366": "0.40%",
"interactions": "what was clicked and matched", "remaining": "what is left", "commit": "<sha>", "by": "<your role>"}}}`.
Create it if missing. Read it before starting (earlier agents may have done part of your chunk: do not redo verified
work, but do re-check anything not "verified"). Update the entries of YOUR pages when you finish each page and again at
the end. Only a reviewer sets "verified". The folder is git-ignored; never commit it.

## How to port
- One Angular component per reference component: same markup, same CSS classes (from `src/styles/_site.scss`,
  generated from the reference Tailwind classes), same texts, same `data-testid`s, same conditional rendering, same
  API calls (paths, methods, bodies, query strings), same validation and error texts. Standalone components, signals,
  OnPush, zoneless; icons via the existing icon setup. Clean, typed, well-structured code that a senior Angular team
  would be proud of: small focused components, no copy-paste, no `any` where a type is known, no dead code.
- A Tailwind class missing from `_site.scss`: add it exactly as Tailwind would generate it and list it in your report.
- Page titles as the reference `metadata` / `generateMetadata`.
- Code comments describe what the code does for PixCart; never write "reference", "port", ".tsx", "Next" or "React" in
  code comments or UI text (those are working words for you, not for the codebase).

## Run and compare
- Shell: Git Bash. Put `C:\Users\haris\pixcart-tools\node-v22.23.5-win-x64` first on PATH (the default node is too
  old). ALWAYS `export MSYS_NO_PATHCONV=1` before passing URL paths such as `/admin/orders` to node, or Git Bash rewrites
  them into Windows paths.
- Install if missing: `npx -y npm@11 ci --no-audit --no-fund` in `PixCartWeb`; `npx -y npm@11 install --no-audit
  --no-fund` in `tools/parity`.
- ONE shared Angular dev server per group, on the group's port (given in your task). First check whether it already
  answers (`curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/`). If it answers, use it: it rebuilds on
  every file change. If not, start it in the background (`npx ng serve --port <port>` in `PixCartWeb`) and wait until it
  answers. LEAVE IT RUNNING when you finish (the next agent of the group uses it), unless your task says you are the
  last step of the group. It listens on IPv6 localhost: use `http://localhost:<port>`, not 127.0.0.1. Its proxy sends
  /api and /media to the reference API on http://localhost:8100 (same demo data as the reference site). Never edit
  proxy.conf.json.
- The reference site runs at http://localhost:3100 (production build) with its API on 8100. Never start, stop or
  restart them. If 3100 or 8100 is down, say so in your report; do not try to fix it.
- Pixel comparison: `node tools/parity/compare.cjs --ng http://localhost:<port> --routes <comma list of real URLs>
  --as <guest|customer|admin|seller|partner> --viewports 390x844,1366x900 --themes classic --out <dir>` (read the header
  of compare.cjs for all options; use `--full` for full-page shots). For `--as admin` set PARITY_ADMIN_PASSWORD to the
  contents of `C:\Users\haris\pixcart-tools\parity-admin-password.txt` (never write the password into any file).
  The reference can be slow: if compare.cjs times out, copy it into your scratchpad folder, raise its timeouts there
  (e.g. 180 s), and run the copy. Do not edit the repository copy.
- Find real ids/slugs through the API on http://localhost:8100. Demo phones: seller 9000000001, partner 7300000001,
  customer 9999900001. compare.cjs signs in on every run (two one-time codes for seller/partner/customer). The local
  limit is 20 codes per phone per hour, shared with other agents: put all the routes of a check into ONE compare run, and
  reuse one signed-in Playwright context for your interaction checks. If a sign-in is refused (429), wait 10 minutes and
  continue with other work meanwhile.
- Target: every route ≤ 0.5% different at both widths. Open the `.diff.png` files and fix every real difference. Live
  data that changes between the two screenshots (timestamps, counters, badges) is acceptable: say which.
- Interactions: click through every control of every page of your chunk on BOTH sites with Playwright (from
  `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\e2e\node_modules`) and make the Angular behaviour
  identical (states, dialogs, validation texts, toasts, URL query strings, API requests).
- The demo database is shared: you may create or edit test records through the UI, but never bulk-delete, and restore
  any global setting you change (storefront theme, integrations, staff roles, marketplace settings, sign-in settings).
  No real payment providers, no SMS/email to real people.
- `npx ng build` must finish with 0 errors before each commit (the dev server may keep running meanwhile).

## Rules
- Commit on your branch with this exact identity (a neutral project identity; never use any personal email):
  `git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -m "..."`. Never add a Co-Authored-By or
  "Generated with" line, and never mention AI tools, the reference or porting in commit messages. Commit after each page.
- Never push, merge, rebase, or touch other branches or worktrees. Never edit `main` or the reference repo. Never deploy.
- No secrets in code. Do not delete files you did not create.
- At most ONE browser at a time (the machine has little free memory); close it before you finish. Stop every background
  process you started EXCEPT the group's dev server (see above).
- Do not stop early. If you run out of time, commit what works, update the ledger, and report exactly what is left.
