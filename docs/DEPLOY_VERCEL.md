# Deploying with Vercel

The project has two parts that deploy separately:

| Part | Folder | Where it can run |
|---|---|---|
| Website: shop, seller hub, admin panel, delivery partner app | `frontend/` | **Vercel** (recommended for this part) |
| API, database and background jobs | `backend/` + PostgreSQL | A server or container host, **not Vercel** |

Why the API cannot go on Vercel: it is a long-running service. It runs scheduled jobs every few seconds (delivery
offers, expiring unpaid orders, notifications, refunds, weekly payouts), keeps a PostgreSQL database, and stores
uploaded images. Vercel functions stop between requests and cannot run those jobs.

## Live demo (everything on Vercel)

A demo runs fully on Vercel: the website at **https://pixcart-shop.vercel.app** and the API at
**https://pixcart-api.vercel.app**, with a Neon Postgres database (free plan, Singapore) created from Vercel →
Storage and connected to the API project. Both projects are in Singapore (`sin1`), close to Indian shoppers.

How the API runs on Vercel (demo only):

- A folder with `app/` (copied from `backend/app`), the sample images in `media/`, a slim `requirements.txt`
  (no test tools, no boto3), `api/index.py` (imports `app.main:app`, sets `MEDIA_ROOT` to the bundled images and
  `RUN_JOBS=false`) and a `vercel.json` that sends every path to that function. Deployed with
  `vercel deploy --prod` into the `pixcart-api` project.
- Settings on `pixcart-api`: `DATABASE_URL` (Neon, `postgresql+asyncpg://…?ssl=require`, the unpooled host),
  `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `ENVIRONMENT=development` (shows the one-time code on screen, since no SMS
  is connected), `RUN_JOBS=false`, `COOKIE_SECURE=true`, `PUBLIC_WEB_URL` and `CORS_ORIGINS` = the website address.
- The database was filled once from a computer: `alembic upgrade head`, `python -m scripts.seed --demo` (with
  `MEDIA_ROOT` pointing at the folder's `media/`), `python -m scripts.create_admin`.

Demo limits: no background jobs (delivery requests do not time out by themselves, queued messages are not sent,
unpaid online orders are not cancelled automatically), new image uploads are not kept, and the first request after a
quiet period is slower. For real use, move the API to a server (section 1) and keep the website on Vercel.

**Automatic updates:** connect the `pixcart-shop` project to this GitHub repository (Vercel → project → Settings →
Git, Root Directory `frontend`). Every push to `main` then rebuilds the website; `frontend/vercel.json` tells Vercel
it is a Next.js site in Singapore.

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
