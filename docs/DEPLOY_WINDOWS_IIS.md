# Deploying PixCart on Windows hosting (IIS + MySQL)

One IIS website runs everything: the ASP.NET Core API and the Angular site (served from `wwwroot`), on one address.
Background jobs (payment expiry, refunds, notifications, payouts, delivery sweeps) run inside the same app.

## 1. What the server needs (once)

| Item | Version | Notes |
|---|---|---|
| Windows Server | 2019 or newer, IIS 10 | Roles: Web Server (IIS) with "Application Initialization" |
| ASP.NET Core Hosting Bundle | .NET 10 | https://dotnet.microsoft.com/download/dotnet/10.0 → "Hosting Bundle"; restart IIS after installing (`iisreset`) |
| MySQL | 8.4 LTS (or 8.0.32+) | On the same server or a managed MySQL. Character set utf8mb4. |
| HTTPS certificate | any | Bind it to the site (win-acme gives free Let's Encrypt certificates) |

## 2. Database (once)

```sql
CREATE DATABASE pixcart CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'pixcart'@'localhost' IDENTIFIED BY '<strong password>';
GRANT ALL ON pixcart.* TO 'pixcart'@'localhost';
```

The tables are created automatically when the site starts the first time (scripts in `PixCartAPI/DAL/Helpers/Scripts`),
and later versions add their changes the same way.

## 3. Build the package (on a build computer)

Needs the .NET 10 SDK and Node.js 22.

```powershell
powershell -ExecutionPolicy Bypass -File tools\publish-windows.ps1
```

Result: `publish\PixCart\` (API.dll, web.config, wwwroot\ with the Angular site, logs\).

## 4. Create the IIS site (once)

1. Copy `publish\PixCart\` to the server, e.g. `C:\inetpub\PixCart`.
2. IIS Manager → Application Pools → Add: name `PixCart`, .NET CLR version **No Managed Code**, Integrated.
   Advanced Settings: **Start Mode = AlwaysRunning**, **Idle Time-out = 0** (keeps background jobs running),
   Load User Profile = True.
3. IIS Manager → Sites → Add Website: name `PixCart`, physical path `C:\inetpub\PixCart`, app pool `PixCart`,
   binding https on your domain with the certificate (and http that redirects to https).
   Site → Advanced Settings → **Preload Enabled = True**.
4. Give the app pool write access to the upload folders:
   `icacls C:\inetpub\PixCart\var /grant "IIS AppPool\PixCart":(OI)(CI)M` (create `var` first).

## 5. Settings and secrets

Edit `C:\inetpub\PixCart\web.config` → `<environmentVariables>` (or create `appsettings.Production.json` next to
API.dll; never commit secrets to git). Required:

| Variable | Example |
|---|---|
| `App__ConnectionString` | `Server=localhost;Port=3306;Database=pixcart;User=pixcart;Password=...;` |
| `App__PublicWebUrl` | `https://shop.yourcompany.in` |
| `App__CorsOrigins` | `https://shop.yourcompany.in` |
| `App__JwtSecret` | 64 random characters |
| `App__FieldEncryptionKey` | a Fernet key (32 bytes, urlsafe base64). **Keep it forever**: it decrypts stored PAN, bank numbers and API keys. When moving data from the Python version, use the same key it used. |
| `App__CookieSecure` | `true` |
| `App__MediaRoot` / `App__PrivateRoot` | `C:\inetpub\PixCart\var\media` / `...\var\private` |
| `App__StorageBackend` | `local` (default) or `ftp` with `App__FtpHost`, `App__FtpUser`, `App__FtpPassword`, `App__FtpBaseDir` |
| `App__TrustProxyHeaders` | `true` only behind a load balancer / ARR that sets X-Forwarded-For |

Payment (Razorpay), SMS (MSG91), email (SMTP), WhatsApp, push (Firebase), shipping (Shiprocket) and AI keys are
entered later in **Admin → Integrations** (stored encrypted in the database); appsettings values are only defaults.

## 6. First start

1. Browse to the site: the database tables are created on the first request.
2. Create the first admin on the server (PowerShell in the site folder):
   `dotnet API.dll create-admin --email admin@yourcompany.in --name "Owner"` (asks for the password).
3. Sign in at `/admin/login`, then follow Admin → Go-live checklist (business details, Razorpay, SMS, email, pages).
4. Razorpay Dashboard → Webhooks: add `https://<your domain>/api/payments/razorpay/webhook` with the events listed in
   Admin → Integrations → Razorpay.

## 7. Updates

Build a new package (step 3), then on the server: stop the site (or drop `app_offline.htm` into the folder), copy the
new files over the old ones (keep `var\`, `logs\`, `appsettings.Production.json`), start the site. Database changes
apply themselves on start.

## 8. Checks and troubleshooting

- `https://<domain>/api/health` → `{"ok":true}` (database reachable).
- HTTP 500.30 / 502.5: the app did not start; set `stdoutLogEnabled="true"` in web.config and read `logs\stdout*.log`.
- Pages work but refresh on a deep link (e.g. /orders/…) shows 404: `wwwroot\index.html` is missing; rebuild the package.
- Uploads fail: check the `var` folder permission (step 4.4) and `maxAllowedContentLength` in web.config.
- Jobs not running at night: app pool Start Mode AlwaysRunning + Idle Time-out 0 + Preload Enabled.
