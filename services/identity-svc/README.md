# identity-svc

Spring Boot 3.5 / Java 21 (C4-L2). The `/api/auth` surface — register, login, refresh,
step-up, logout, introspect, `can` — plus `GET /api/health`, over the frozen framework-free
domain layer in `src/main/java/.../domain` and the V001/V002 schema.

## Required environment

| Variable | Meaning |
|---|---|
| `IDENTITY_DB_URL` | JDBC URL, e.g. `jdbc:mysql://127.0.0.1:3306/pixcart_dev` |
| `IDENTITY_DB_USER` | DB user |
| `IDENTITY_DB_PASSWORD` | DB password (empty string is a legitimate local value) |
| `IDENTITY_JWT_SECRET` | HS256 signing key, **at least 32 bytes**; no default — the service refuses to start without it |

The MFA-TOTP encryption key is derived from `IDENTITY_JWT_SECRET` via HKDF (label
`pixcart/identity/mfa-totp-secret/v1`); there is no separate secret to configure.

## Database

Flyway migrates from `../../infra/db/migrations` (V001–V006). A database that already has
the schema but no `flyway_schema_history` (as `pixcart_dev` was migrated out-of-band) is
baselined at V006 automatically; V007+ applies on top.

## Run

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot'
$env:IDENTITY_DB_URL = 'jdbc:mysql://127.0.0.1:3306/pixcart_dev'
$env:IDENTITY_DB_USER = 'root'
$env:IDENTITY_DB_PASSWORD = ''
$env:IDENTITY_JWT_SECRET = '<32+ random bytes>'
& "$env:LOCALAPPDATA\maven\apache-maven-3.9.9\bin\mvn.cmd" -B -ntp spring-boot:run
```

Start from this module directory: the Flyway location is relative to the working directory.

## Test

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot'
& "$env:LOCALAPPDATA\maven\apache-maven-3.9.9\bin\mvn.cmd" -B -ntp test
```

The suite (316 tests) runs fully offline: controller/wire tests use a standalone MockMvc
plus an in-memory store that preserves the schema's invariants; no test touches a database
or the network.

## API shape (as implemented)

- `POST /api/auth/register` → 201 `{accessToken, refreshToken, expiresInMs, user, requiresStepUp}`
- `POST /api/auth/login` → 200, same body; bad credentials 401 `E-AUTH-002`, lockout 403 `E-AUTH-003`
- `POST /api/auth/refresh` → 200, rotated pair; replay revokes the family (`REFRESH_TOKEN_REUSE_DETECTED`)
- `POST /api/auth/step-up` → 200 `{stepUpToken, validForMs}`; needs a live session + enrolled factor
- `POST /api/auth/logout` → 200 `{revoked, sessionId}`
- `GET  /api/auth/me` → 200 profile; 401 without a valid bearer token
- `POST /api/auth/introspect` → **always 200** for a well-formed body: `{active, subject, role, sessionId, stepUpSatisfied}` (the BFF treats non-2xx as "anonymous", which would be indistinguishable from an outage)
- `POST /api/auth/can` → 200 `{permitted, access}`; unknown role/capability 400
- `GET  /api/health` → 200 only after a real `SELECT 1`; otherwise 503 problem+json

Failures are RFC 7807 `application/problem+json`: `{type, title, status, detail, code, traceId}`.

## Known gap

There is no MFA-enrolment endpoint in the specified API surface (Vol. 7 §7.4). A customer
registered through this API has no TOTP factor, so `requiresStepUp` is `false` and
`/step-up` refuses with `E-AUTH-011` until a factor is enrolled out-of-band. The step-up
*verification* path is implemented and tested; enrolment needs an API-surface decision.
