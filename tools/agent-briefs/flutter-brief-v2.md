# Brief: PixCart native Flutter apps, identical to the reference website on a phone (v2)

## Goal
The PixCart reference (Python API + Next.js website, READ ONLY:
`C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace`) ships its phone apps as the website inside a
WebView. The company rebuild has native Flutter apps instead (`PixCartMobile`: customer, delivery partner and seller
apps, plus the shared packages `pixcart_core` and `pixcart_ui`). Every Flutter screen must look and behave exactly
like the same page of the reference website at 390 x 844: layout, spacing, fonts, colours, texts, states (loading
skeleton, empty, error), every button and flow, the same API calls. Nothing may stay a placeholder or "coming soon".

## Where
- Your worktree and branch: given in your task. Edit only `PixCartMobile/**` there: your app's folder and, when truly
  needed, the shared packages (list every shared change in your report; other agents work on the other apps in
  parallel, so keep shared changes small and additive).
- Reference pages: `frontend/src/app/...` (the URL is the folder path; folders in parentheses are route groups),
  components in `frontend/src/components`, helpers in `frontend/src/lib`, API in `backend/app/routers`. The apps use the
  same URLs as the website for their routes.
- Study first: `PixCartMobile/packages/pixcart_core` (API client, session, site settings, theme tokens, formats),
  `PixCartMobile/packages/pixcart_ui` (Tw text styles, widgets, skeletons), the finished customer-app screens
  (`apps/customer_app/lib/screens`, `lib/shop/`), its router and its tests with goldens (`apps/customer_app/test`).
  Reuse; never duplicate.

## Run and compare
- Flutter 3.50.1 at `C:\Users\haris\pixcart-tools\flutter\bin` (put it first on PATH). Node 22 at
  `C:\Users\haris\pixcart-tools\node-v22.23.5-win-x64`. Shell: Git Bash; `export MSYS_NO_PATHCONV=1` before passing URL
  paths like `/delivery/trips/x` to node.
- `flutter pub get` in `PixCartMobile`. Build your app for the web against the reference API on 8100 (the same demo data
  the reference site shows): in your app folder `flutter build web --dart-define=API_BASE=http://localhost:8100`
  (add `--dart-define=SITE_URL=http://localhost:3100`). Serve `build/web` on YOUR port with
  `PixCartMobile/tools/parity/serve.cjs` (read it). Only ONE flutter build at a time: the machine has little memory.
- Compare: `node PixCartMobile/tools/parity/compare.cjs --ref http://localhost:3100 --app http://localhost:<port>
  --routes <real URLs> [--login <phone>] --out <dir>` (read its header). The reference site (production build) runs on
  3100 and its API on 8100: never start, stop or restart them; if one is down, say so in your report.
- Demo phones: customer 9999900001, seller 9000000001, delivery partner 7300000001 (sign-in codes come back as dev_otp
  in development). Sign-ins are rate-limited (about 5 codes per hour per phone) and shared with other agents: put all
  routes of a check into ONE compare run, never loop sign-ins; on 429 / "Too many attempts" wait 10 minutes.
- Target: every screen within the tool's threshold. Open the diff images and fix real differences (Chrome and Flutter
  render text slightly differently; layout, colour, spacing and content must match).
- Interact with both: every button, form (identical validation messages), dialog, list, filter, pull to refresh,
  pagination. Payments (customer app) go through the existing payments code and the local Razorpay simulator behind
  the 8100 API, so no real money is involved.
- `flutter analyze` must report no issues. Add widget tests (goldens where the existing tests use them) for each screen
  you build; keep every existing test passing (run each package's tests from its own folder: `flutter test`).

## Rules
- Commit on your branch with this exact identity (a neutral project identity; never use any personal email):
  `git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -m "..."`. Never add a Co-Authored-By or
  "Generated with" line, and never mention AI tools, the reference or porting in commit messages. Commit often.
- Never edit the reference repository or `main`; never push, merge or touch other branches/worktrees; never deploy.
- No secrets in code; no real SMS/email/payments. The demo database is shared: never bulk-delete; restore any global
  setting you change.
- Before you finish, stop every server, browser and background process you started.
- Work through every screen of your app. If you run out of time, commit what works and report exactly what is left.
