# Deploying with Vercel

The project has two parts that deploy separately:

| Part | Folder | Where it can run |
|---|---|---|
| Website: shop, seller hub, admin panel, delivery partner app | `frontend/` | **Vercel** (recommended for this part) |
| API, database and background jobs | `backend/` + PostgreSQL | A server or container host, **not Vercel** |

Why the API cannot go on Vercel: it is a long-running service. It runs scheduled jobs every few seconds (delivery
offers, expiring unpaid orders, notifications, refunds, weekly payouts), keeps a PostgreSQL database, and stores
uploaded images. Vercel functions stop between requests and cannot run those jobs.

## 1. Deploy the API first

Pick one:

- **AWS** (production-grade, already scripted): `infra/terraform` creates the network, database (RDS), containers
  (ECS Fargate), load balancer, firewall and image storage. Follow `docs/DEPLOY.md`.
- **A container host** (simpler: Render, Railway, Fly.io, a VPS with Docker): build `backend/Dockerfile`, add a
  managed PostgreSQL 16 database, and run migrations once with `alembic upgrade head`.

API environment variables (see `backend/.env.example` for the full list):

| Variable | Value |
|---|---|
| `ENVIRONMENT` | `production` |
| `DATABASE_URL` | `postgresql+asyncpg://USER:PASSWORD@HOST:5432/DBNAME` |
| `JWT_SECRET` | a long random string (the API refuses to start in production with the default) |
| `FIELD_ENCRYPTION_KEY` | a new Fernet key (`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`) |
| `PUBLIC_WEB_URL` | your Vercel address, e.g. `https://shop.example.com` |
| `CORS_ORIGINS` | the same address |
| `COOKIE_SECURE` | `true` |
| `STORAGE_BACKEND` | `s3` (with `S3_BUCKET` and its access) so uploaded images survive restarts |

Payment, SMS, email, WhatsApp and AI keys can be added later in **Admin → Integrations**; they are stored encrypted.

## 2. Deploy the website on Vercel

1. In Vercel: **Add New → Project → Import** the GitHub repository.
2. **Root Directory: `frontend`**. Framework is detected as Next.js; keep the default build command.
3. **Node.js version: 22** (Project → Settings → General).
4. Environment variables:

   | Variable | Value |
   |---|---|
   | `API_ORIGIN` | the API's public address, e.g. `https://api.example.com` (no trailing slash) |
   | `PUBLIC_WEB_URL` | the website's address, e.g. `https://shop.example.com` |

5. Deploy. The website forwards `/api/...` and `/media/...` to `API_ORIGIN`, so the browser only ever talks to your
   own domain (sign-in cookies keep working).
6. Add your domain in Vercel → Domains, then update `PUBLIC_WEB_URL` (both sides) and `CORS_ORIGINS` to it.

## 3. After the first deploy

- Sign in at `/admin/login` with the admin account created by the seed or `scripts/create_admin`, and **change the
  password at once** (My account). Turn on two-step sign-in.
- Work through **Admin → Go-live checklist**: business details, payments, SMS, email, policies.
- In **Admin → Sign-in and accounts**, consider requiring two-step sign-in for all staff.
- The delivery partner Android app (`mobile/partner-app`) opens `/delivery` on your domain; rebuild it with your
  address before publishing.

## Checklist

- [ ] API reachable at `https://api.example.com/api/site`
- [ ] Website shows the shop at your domain, and `/admin/login` signs in
- [ ] A test order with cash on delivery goes through
- [ ] Images upload and still show after the API restarts (S3 storage)
- [ ] Default admin password changed
