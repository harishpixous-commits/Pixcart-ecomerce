# PixCart: website and API (Angular + .NET)

A multi-seller marketplace for India: customers shop and pay online (Razorpay) or cash on delivery, sellers manage
products and orders in the seller hub, delivery partners run trips, and staff run everything from the admin panel.

The Flutter apps (customer, delivery partner, seller) are in the
[Pix-ShopCart_Mobile](https://github.com/PixoustechIndia-org/Pix-ShopCart_Mobile) repository.

## Stack

| Part | Technology |
|---|---|
| API | ASP.NET Core, .NET 10 (`PixCartAPI`) |
| Database | MySQL 8.4 with Dapper |
| Website | Angular 21 (zoneless, signals), SCSS, PrimeNG components, Bootstrap grid (`PixCartWeb`) |
| Hosting | Windows Server + IIS, one site serving the website and `/api` |

## Folders

```
PixCartAPI/
  API/         controllers, configuration, middleware, infrastructure (hosting, guards, workers)
  BAL/         business logic (interfaces in BAL/Interface, background workers in BAL/BackgroundWorkerService)
  DAL/         MySQL data access (Dapper) and the database scripts (DAL/Helpers/Scripts)
  Model/       domain models, constants, attributes, mapping
  Utils/       helpers (settings, encryption, SMS, email, storage, dates)
  Tests/       xUnit tests against a real MySQL database
PixCartWeb/    the Angular website: storefront (4 themes), seller hub, delivery partner pages, admin panel
tools/         publish-windows.ps1 (builds the IIS package)
docs/          product rules and specs, Windows/IIS deployment
```

## Run it locally

Requirements: .NET 10 SDK, Node 22, MySQL 8.4.

```powershell
# API on http://localhost:5080 (creates and migrates the database on start)
cd PixCartAPI\API
$env:App__ConnectionString = "Server=127.0.0.1;Port=3306;Database=pixcart;User=pixcart;Password=...;"
dotnet run

# Website on http://localhost:4201 (/api and /media go to the API, see PixCartWeb/proxy.conf.json)
cd PixCartWeb
npx -y npm@11 ci
npx ng serve
```

In development, sign-in codes are written to the API log instead of being sent by SMS.

## Tests

```powershell
cd PixCartAPI; dotnet test Tests/Tests.csproj           # needs MySQL; set TEST_MYSQL="Server=...;User=root;Password=...;"
cd PixCartWeb; npx ng build; npm run test:shop-contracts
```

CI (`.github/workflows/ci.yml`) runs the API tests against MySQL 8.4, builds the website, runs the screen tests
and builds the IIS package on every push and pull request to `main`. It never deploys.

## Deploy (Windows/IIS)

Follow [docs/DEPLOY_WINDOWS_IIS.md](docs/DEPLOY_WINDOWS_IIS.md). `tools/publish-windows.ps1` builds one folder with
the API and the website. Production refuses to start without its own `App__JwtSecret`,
`App__FieldEncryptionKey` and `App__CookieSecure=true`. Payment, SMS, email and other provider keys are entered in
Admin → Integrations.

## Rules for changes

- Every change keeps the website, the API and the mobile apps in step: same screens, texts, options and flows.
- Money is in integer paise; dates are shown in IST; API errors are `{"error":{"code","message","fields"}}`.
- No secrets in code. Keys go in environment variables or Admin → Integrations.
- Keep changes small, with tests; CI must stay green.
