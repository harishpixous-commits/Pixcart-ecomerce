# Porting guide: PixCart (Python/Next.js reference) → ASP.NET Core + MySQL + Angular

The `dotnet-angular` branch rebuilds PixCart in the company stack. The **reference** is the `main` branch
(checked out at `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace`): FastAPI in `backend/`,
Next.js in `frontend/`. The rebuilt product must behave and look **exactly** the same: same screens pixel for pixel,
same workflows, same rules, same messages. Never change the reference repository.

## 1. The contract: identical HTTP API

The .NET API keeps the reference API's contract exactly, so the screens port one to one and the reference browser
tests (`e2e/` on main) can run against the new stack:

- Same paths (`/api/orders/{id}/payment-status`), methods, query parameters and status codes.
- Same JSON: snake_case names (automatic), same nesting, same field names, ISO times with `+00:00`
  (`DateTimeFunctions.Iso`), money in integer paise, ids as UUID strings.
- Same errors: `{"error": {"code", "message", "fields"}}` with the same `code` strings and the same messages
  (throw `AppException`/`NotFoundException`/... from Utils). Validation errors: 422 `validation_error`.
- Same auth: bearer access token (JWT: sub, adm, iat, exp, typ=access), refresh token in the HttpOnly cookie
  `pc_refresh` (path `/api/auth`), `X-Requested-With` header on cookie endpoints, same rate limits.
- Read the reference router **and** the services it calls before writing an endpoint. Port the behaviour, including
  edge cases, permission checks, audit log entries, notifications and background tasks.

## 2. Backend layout (company structure — do not invent new top-level folders)

```
PixCartAPI/
  API/            Controllers/<Area>Controller.cs   [ApiController], attribute routes with the full path ("/api/...")
                  Configurations/  Helpers/  Infrastructure/  Middleware/  Service/   (shared pieces, already built)
  BAL/            <Area>BAL.cs + Interface/I<Area>BAL.cs        business rules (one class per area)
                  BackgroundWorkerService/<Name>Worker.cs      scheduled jobs (BackgroundService), auto-registered
  DAL/            <Area>DAL.cs                                  SQL with Dapper, nothing else
                  Helpers/Scripts/V###__name.sql                schema changes (never edit V001; add a new script)
  Model/          DomainModel/<Table>Model.cs                   one class per table (GENERATED, do not edit)
                  DomainModel/<Area>/*.cs                       request/response shapes of an area (records)
                  Constants/  CustomeAttributes/  Automapper.cs (Mapster)
  Utils/          Interface/ + helpers (MySqlDapperHelper, Mail, SMS, FTP, ImageUpload, EncryptDecrypt, JsonHelper, dates)
  Tests/          xUnit integration tests (WebApplicationFactory + a real MySQL test database)
```

- Classes named `*DAL` and `*BAL` are registered automatically (BAL under its `I*BAL` interface). No Program.cs edits.
- Controllers stay thin: read input, call the BAL, return the BAL's result. Authorisation with attributes:
  `[SignedIn]`, `[Perm("orders")]`, `[AdminOnly]`, `[Seller]` / `[Seller(Approved = false)]`, `[RequireCsrfHeader]`.
  The signed-in user: inject `ICurrentUser` (`await me.RequireAsync()`, `RequireSellerAsync()`, `IpAddress`).
- Request bodies: records in `Model/DomainModel/<Area>/` with DataAnnotations (`[Required]`, `[StringLength]`,
  `[RegularExpression]`, `[Range]`); custom Indian formats in `Model/CustomeAttributes` (PIN code, GSTIN, PAN, IFSC,
  mobile). Return anonymous objects or records whose snake_case serialisation equals the reference JSON.
- Settings areas (`platform_settings` rows such as "auth", "regional", "site"): `SettingsDAL.GetAsync(key)` merged over
  the area's defaults (`SettingsDAL.Merge`), exactly the reference `DEFAULTS` dict, same validation rules.
- Transactions: `await using var uow = await db.BeginAsync();` ... `await uow.CommitAsync();`. Row locks:
  `SELECT ... FOR UPDATE` inside the unit (the reference uses `with_for_update()` in the same places).
- Ids: `Guid.NewGuid()` in C#. Times: `DateTimeFunctions.UtcNow()`; India time with `DateTimeFunctions.ToIst`.

### PostgreSQL → MySQL 8.4 cheat sheet

| Reference (PostgreSQL / SQLAlchemy) | MySQL |
|---|---|
| `ILIKE` | `LIKE` (the collation is case-insensitive) + `SqlHelpers.Contains()` for escaping |
| `RETURNING` | read back with a SELECT in the same unit of work |
| `ON CONFLICT DO NOTHING / DO UPDATE` | `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE` |
| JSONB `->`, `->>`, `@>` | `JSON_EXTRACT`, `->>`, `JSON_CONTAINS`; JSON columns are text in the models (`JsonHelper`) |
| `now()` | `UTC_TIMESTAMP(6)` (or pass `DateTimeFunctions.UtcNow()`) |
| `date_trunc('day', x AT TIME ZONE 'Asia/Kolkata')` | `DATE(CONVERT_TZ(x, '+00:00', '+05:30'))` |
| `x + interval '3 days'` | `DATE_ADD(x, INTERVAL 3 DAY)` |
| `generate_series` | build the date list in C# |
| `FOR UPDATE SKIP LOCKED` | same (MySQL 8) |
| full-text (`search_vector`, `word_similarity`) | `MATCH(title, brand, description) AGAINST (@q IN NATURAL LANGUAGE MODE)` plus `LIKE` for prefixes |
| partial unique index on delivery_assignments | generated column `active_sub_order_id` (already in V001) |
| `greatest`, `coalesce`, `count(*) filter (where ...)` | `GREATEST`, `COALESCE`, `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` |
| reserved words used as columns (`key`, `value`, `condition`, `rank`) | quote with backticks |

### Libraries (all free for commercial use)

Dapper + MySqlConnector, Mapster (instead of AutoMapper), BCrypt.Net-Next, MailKit, FluentFTP, SkiaSharp (images),
PDFsharp-MigraDoc (PDF invoices and documents), ClosedXML (Excel), System.IdentityModel.Tokens.Jwt.
Do not add AutoMapper ≥ 15, QuestPDF or ImageSharp (paid licences).

## 3. Frontend layout (Angular 21, SCSS, PrimeNG, Bootstrap grid)

```
PixCartWeb/src/
  styles.scss, styles/_site.scss     design system (generated from the reference styles: same class names)
  app/core/      api.ts (HTTP + refresh), session, site + theme, regional + i18n, format, types (ported from frontend/src/lib)
  app/shared/    ui components (button, field, modal, toast, pill, skeletons ...) built on PrimeNG, back button, icons
  app/shop/      storefront (home, category, search, product, cart, checkout, orders, account, help ...)
  app/seller/    seller hub         app/delivery/   delivery partner app        app/admin/   admin panel
```

- Standalone components, signals, OnPush, zoneless. One component per reference component/page; same file split.
- Port each `.tsx` to an Angular component with **the same markup, the same classes, the same texts and the same
  `data-testid` attributes**. Class names come from `_site.scss`, so the look is identical without new CSS. Use
  component `.scss` only for what the reference wrote as custom CSS.
- PrimeNG for the interactive controls (Button, Dialog, Select, DatePicker, Table, Checkbox, Toast, Drawer ...) in
  unstyled mode with the pass-through classes from `app/core/primeng-pt.ts`, so they render with the reference classes.
- Icons: `lucide-angular` (the same icon set and names as the reference's lucide-react).
- Routing mirrors the reference URLs exactly (`/p/:slug`, `/orders/:id`, `/admin/delivery/live` ...).
- Framework-free reference code (`frontend/src/lib/format.ts`, `tokens.ts`, `theme.ts`, `i18n.ts`, `razorpay.ts`,
  `types.ts`, `regional-shared.ts`, theme manifests) is copied with only the React parts replaced.
- Responsive behaviour must match at 390 px (phone), 768 px (tablet) and 1366 px (desktop).

## 4. Verifying parity

- Backend: port the reference pytest tests of the module to xUnit (`PixCartAPI/Tests`), same scenarios, same
  expectations. `dotnet test` must pass.
- Frontend: compare screenshots of each route with the reference at 390 and 1366 px
  (`tools/parity/compare.cjs`); run the reference Playwright suite (`e2e/` on main) with `BASE_URL` set to the Angular app.

## 5. Working in parallel (one module per person/agent)

Each module is ported in its own git worktree and branch, then merged into `dotnet-angular`:

```
git -C C:\Users\haris\Downloads\PixCart-Angular-DotNet worktree add ..\PixCart-wt-<name> -b port/<name> dotnet-angular
```

Use your own MySQL test database (`pixcart_<name>`) and your own ports. Only create or change the files of your
module; shared files (Program.cs, ServiceConfiguration.cs, app.routes.ts, styles) belong to the integrator. Commit
on your branch with clear messages; do not merge, push or delete other branches.

Local tools: MySQL 8.4 at 127.0.0.1:3307 (root/pixcart, user pixcart/pixcart), Node 22 at
`C:\Users\haris\pixcart-tools\node-v22.23.5-win-x64` (use `npx -y npm@11 install`), .NET SDK 10, Chromium for
screenshots at `C:\Users\haris\AppData\Local\ms-playwright\chromium-1254\chrome-win64\chrome.exe`.
