# Handoff: continuing the Angular + .NET rebuild of PixCart

Repository: https://github.com/harishpixous-commits/Pixcart-ecomerce

## Branches

| Branch | What it is | Rule |
|---|---|---|
| `main` | The **live** version: FastAPI (Python) + Next.js + PostgreSQL, deployed on Vercel (pixcart-shop / pixcart-api). The reference for behaviour and look. | Never merge anything from the rebuild into it. Change it only when the owner asks for a change (then make the same change in both versions). |
| `dotnet-angular` | The rebuild in the company stack: ASP.NET Core (.NET 10) + MySQL 8.4 + Angular 21 (SCSS, PrimeNG, Bootstrap grid) + Flutter apps. Integration branch. | Merge finished module branches here. |
| `port/auth` | WIP: sign-in, accounts, addresses, push, integrations, webhooks, staff, admin accounts/prefs, notifications, support, wishlist, account export/delete. Stopped while writing tests. | Finish, test, merge into dotnet-angular. |
| `port/catalog` | WIP: /api/site + CMS + themes, platform settings, catalogue + search (MySQL FULLTEXT), reviews, Q&A, regional/translate, saved cards. Stopped early (models/validation written). | Finish, test, merge. |
| `port/web-core` | WIP: Angular core services, themes engine, shop chrome, shared UI on PrimeNG, panel shells, routing with placeholders, home + login pages, parity tool. | Finish, verify pixel parity, merge. |
| `port/flutter` | WIP: Flutter workspace (packages/pixcart_core, packages/pixcart_ui, apps/customer_app, partner_app, seller_app). | Finish, verify, merge. |
| (not started) `port/ai` | AI adapter layer (app/llm: Anthropic + OpenAI-compatible providers, keys, routes, fallbacks, streaming, tools), AI studio, admin assistant, shop assistant, docgen. | Start from dotnet-angular. |

## Read first

1. `docs/PORTING_GUIDE.md` — the rules: identical API contract, company folder layout, PostgreSQL→MySQL cheat sheet,
   allowed libraries, Angular conventions, verification, worktree workflow.
2. `docs/DEPLOY_WINDOWS_IIS.md` — the target hosting (one IIS site serves API + Angular from wwwroot).
3. The reference code on `main`: `backend/app` (routers, services, models, tests) and `frontend/src` (pages, components, lib, themes).

## What is done on dotnet-angular

- `PixCartAPI/` solution in the company layout (API: Configurations, Controllers, Helpers, Infrastructure, Middleware,
  Service; BAL: Interface, BackgroundWorkerService; DAL: Helpers/Scripts; Model: Constants, CustomeAttributes,
  DomainModel, Automapper.cs (Mapster); Utils: Interface, UtilModels, MySqlDapperHelper, MySqlHelper, MailHelper (MailKit),
  SMSHelper (MSG91/console), FTPHelpers (FluentFTP), ImageUpload (SkiaSharp → WebP), EncryptDecrypt (bcrypt, Fernet,
  tokens), JsonHelper, date helpers).
- MySQL schema `DAL/Helpers/Scripts/V001__schema.sql` (78 tables) and `Model/DomainModel/*Model.cs`, both generated from
  the reference data model (`tools/schema/*.py`). `DatabaseMigrator` applies scripts at startup.
- Same contract as the reference: snake_case JSON, `{"error":{code,message,fields}}`, JWT access tokens (sub, adm, iat,
  exp, typ), refresh cookie `pc_refresh`, roles/permissions (`[Perm("orders")]`, `[SignedIn]`, `[AdminOnly]`, `[Seller]`).
- Windows hosting: SPA served from wwwroot with fallback, `web.config`, `tools/publish-windows.ps1`,
  `dotnet API.dll create-admin` / `migrate`.
- `tools/DataMigrator` copies all data + images PostgreSQL → MySQL (tested on the demo data: 1,998 rows, 62 images).
- `PixCartWeb/` Angular 21 workspace: PrimeNG, lucide-angular, Bootstrap grid only, the reference fonts,
  `src/styles/_site.scss` generated from the reference Tailwind config (same class names → same look).

## Remaining modules (in a sensible order)

1. Finish `port/auth`, `port/catalog`, `port/web-core` (above) and merge.
2. Commerce: cart, checkout quote, orders, payments (Razorpay orders/verify/callback/webhook/payment-status, currencies,
   saved cards), coupons, fees, deals, inventory, invoices + credit notes (PDF), ledger, returns, refunds, delivery
   estimate, Shiprocket. Reference: routers cart.py, orders.py, parts of customer.py, checkout_admin.py; services orders,
   fees, coupons, deals, inventory, invoices, fee_invoices, ledger, returns, shipping, razorpay, delivery; tests
   test_orders*, test_order_*, test_payment_check, test_checkout_fees, test_returns_policy, test_rto_restock, test_stock_ops,
   test_phase2_money, test_ledger_fixes, test_cart_limits.
3. Seller hub: seller_onboarding.py, seller_products.py, seller_orders.py, seller_extras.py, product_import, exports.
4. Delivery: delivery.py, delivery_admin.py, services/fleet.py, delivery_settings (partner app + admin fleet).
5. Admin: admin.py, admin_extras.py, admin_search.py, reports, analytics, promotions (ads, deals, coupons), payouts, jobs
   (BackgroundWorkerService: payment expiry, refunds, notifications, payouts, delivery sweeps, deals).
6. AI (port/ai, see table).
7. Angular feature pages replacing the placeholders: shop, account/orders/checkout, seller, delivery, admin.
8. Flutter apps: customer (with razorpay_flutter), delivery partner, seller.
9. Verification and release: run the reference Playwright suite (`e2e/` on main, 45 tests) against Angular + .NET;
   screenshot every route at 390 and 1366 px vs the live site (`tools/parity/compare.cjs`); `tools/publish-windows.ps1`
   and an IIS test install; the five flow videos re-recorded on the new version.

## Local environment used so far (Windows)

- MySQL 8.4: `C:\Users\haris\pixcart-tools\mysql` running on 127.0.0.1:3307 (root/pixcart; user pixcart/pixcart;
  databases `pixcart`, `pixcart_demo` = copy of the demo data). Start: `mysql\bin\mysqld.exe --datadir=...\mysql-data --port=3307`.
- Reference stack for comparison: PostgreSQL on 5433 (`pixcart_demo`), Python API on 8100, Next.js on 3100.
  Demo logins: customer 9999900001, seller 9000000001, partner 7300000001 (OTP returned as `dev_otp`), admin
  admin@pixcart.in (password in the owner's notes).
- Ports for the rebuild: .NET API 5080, Angular 4200 (proxy /api and /media to 5080; or to 8100 to develop against the
  reference API).
- Tools: .NET SDK 10, Node 22 (`npx -y npm@11 install`: npm 10 has an install bug here), Flutter 3.50.1 at
  `C:\Users\haris\pixcart-tools\flutter`, Chromium for screenshots (Playwright).

## Definition of done (set by the owner)

Every screen and workflow identical to the live version (pixel-perfect at phone and desktop sizes), all integrations
(Razorpay incl. UPI apps and saved cards, SMS, email, WhatsApp, push, Shiprocket) and AI (adapters, assistant, studio,
shop assistant) working, deployable on Windows/IIS with MySQL, Flutter apps for customer, delivery partner and seller,
all tests passing, every screen compared, and the five flow videos recorded. Commit as
`git -c user.name="harish" -c user.email="harishc.pixous@gmail.com" commit` with "Co-Authored-By" trailer as used in
the history; push to the branches above.
