# Prompt to continue the work in a new AI session

Copy everything in the block below into the new session.

```
You are continuing a large rebuild of the PixCart multi-seller marketplace.

Repository: https://github.com/harishpixous-commits/Pixcart-ecomerce
- Branch `main` = the LIVE version (FastAPI/Python + Next.js + PostgreSQL, on Vercel). It is the reference for every
  behaviour, rule, message and pixel. Do NOT change main, do NOT deploy to the live Vercel projects, and NEVER merge
  the rebuild into main.
- Branch `dotnet-angular` = the rebuild in my company's stack. Continue here. Module work is on branches port/<name>
  (port/auth, port/catalog, port/web-core, port/flutter, port/ai) — continue each from its last commit.

FIRST read on dotnet-angular: docs/HANDOFF.md (state, branches, what is left, environment), docs/PORTING_GUIDE.md
(rules), docs/DEPLOY_WINDOWS_IIS.md (target hosting). Then read the reference code on main (backend/app routers,
services, models, tests; frontend/src pages, components, lib, themes).

Company tech stack and structure (must follow exactly):
- Backend: ASP.NET Core .NET 10 Web API, solution PixCartAPI with 5 projects:
  API (Configurations, Controllers, Helpers, Infrastructure, Middleware, Service, appsettings.json, Program.cs),
  BAL (Interface/I<Area>BAL.cs, <Area>BAL.cs, BackgroundWorkerService/ for scheduled jobs),
  DAL (<Area>DAL.cs with Dapper, Helpers/Scripts/V###__*.sql),
  Model (DomainModel, Constants, CustomeAttributes, Automapper.cs using Mapster),
  Utils (Interface: IMySqlDapperHelper, IMySqlHelper, IMailHelper, IMailConfig, ISMSHelper, IFTPHelpers, IImageUpload;
  UtilModels; helpers).
- Database: MySQL 8.4 (Dapper + MySqlConnector). Schema already generated (78 tables).
- Frontend: Angular 21 (standalone, signals, zoneless) + SCSS + PrimeNG for all UI components (unstyled mode with
  pass-through classes) + Bootstrap ONLY for the grid. src/styles/_site.scss reproduces the live site's classes, so
  templates keep the same class names and look identical.
- Mobile: Flutter apps for customer, delivery partner and seller (PixCartMobile/), Razorpay via razorpay_flutter,
  matching the mobile website pixel for pixel.
- Hosting: Windows IIS + MySQL (one IIS site serves the API and the Angular build from wwwroot).
- Free libraries only: Mapster (not AutoMapper 15+), PDFsharp-MigraDoc, ClosedXML, MailKit, FluentFTP, SkiaSharp,
  BCrypt.Net-Next.

Contract: the .NET API must keep EXACTLY the live API's paths, JSON shapes (snake_case), status codes, error format
{"error":{code,message,fields}}, auth (JWT access token + pc_refresh cookie) and permissions, so screens port 1:1
and the live Playwright tests (e2e/ on main, 45 tests) run unchanged against the new stack.

Work order (see HANDOFF.md):
1. Finish the WIP branches port/auth, port/catalog, port/web-core, port/flutter, port/ai (start from their last
   commit), test them, merge into dotnet-angular.
2. Port the remaining backend modules: commerce (cart, orders, Razorpay payments incl. UPI apps, callback, webhook,
   payment-status, currencies, saved cards; coupons, fees, deals, inventory, PDF invoices, ledger, returns, refunds,
   Shiprocket), seller hub, delivery (partner app + admin fleet), admin (reports, payouts, promotions, search,
   settings), background jobs, AI (app/llm adapter layer for Claude + OpenAI-compatible providers with keys, routes,
   fallbacks, streaming, tools; AI studio; admin assistant; shop assistant).
   Port each module's pytest tests to xUnit (PixCartAPI/Tests, real MySQL test database) and make them pass.
3. Replace every Angular placeholder page with the real screen ported from the matching Next.js page (same markup,
   classes, texts, data-testid), for shop, account/orders/checkout, seller hub, delivery app and admin panel,
   responsive at 390 / 768 / 1366 px, including image zoom and the full-screen photo viewer.
4. Finish the three Flutter apps.
5. Verify: run the live e2e suite against Angular + .NET (all must pass); screenshot every route at 390 and 1366 px
   against the live site and fix differences; build with tools/publish-windows.ps1 and test an IIS install;
   copy the data with tools/DataMigrator; then record the five flow videos (web order, mobile order, admin, seller,
   delivery partner) on the new version.

Rules: work module by module, build and test after each, commit in small steps with clear messages, push to
GitHub (module branches port/<name>, merged into dotnet-angular), never touch main or the live Vercel site, and do not
claim something works until it is verified. When a change is later requested for the product, make it in BOTH main
and dotnet-angular. Report progress after each module and say "fully complete" only when everything above is
verified.
```
