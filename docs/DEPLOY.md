# Deploying on AWS (Mumbai, ap-south-1)

Everything is described in `infra/terraform` and shipped by `.github/workflows/deploy.yml`.

## What Terraform creates

| Piece | AWS |
|---|---|
| Network | VPC across 2 zones, public subnets for the load balancer, private subnets for apps and database, one NAT gateway, S3 gateway endpoint |
| Database | RDS PostgreSQL 16, Multi-AZ, encrypted, TLS required, 14-day backups, deletion protection, Performance Insights |
| Apps | ECS Fargate: `api` (FastAPI + scheduled jobs) and `web` (Next.js), 2 to 10 tasks each with CPU autoscaling, deployment circuit breaker with rollback; ECS Service Connect so the web reaches the API at `http://api:8000` |
| Entry | Application Load Balancer, HTTPS only (TLS 1.2+), `/api/*` to the API and everything else to the web, AWS WAF (common rules, bad inputs, 2000 requests per 5 minutes per IP), access logs |
| Images | Private S3 bucket behind CloudFront on your `cdn.` domain; KYC documents in a second private, versioned bucket |
| Secrets | Secrets Manager: `<name>/generated` (database URL, JWT secret, encryption key, made by Terraform) and `<name>/integrations` (your third-party keys) |
| Registry | ECR repositories with immutable tags and scan on push |
| Monitoring | CloudWatch alarms by email: 5xx errors, latency, unhealthy API tasks, database CPU, storage and connections, logged application errors |
| Deploy access | GitHub OIDC role: no AWS keys are stored in GitHub |

## First-time setup

1. In Route 53, have a hosted zone for your domain (e.g. `yourshop.in`).
2. Create an S3 bucket for Terraform state (versioning on). Copy `backend.hcl.example` to `backend.hcl` and
   `terraform.tfvars.example` to `terraform.tfvars`, and fill both.
3. Build and push a first pair of images tagged `latest`, because the ECS services need an image to start:
   ```bash
   cd infra/terraform
   terraform init -backend-config=backend.hcl
   terraform apply -target=aws_ecr_repository.repo
   aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.ap-south-1.amazonaws.com
   docker build -t <ecr_api>:latest ../../backend && docker push <ecr_api>:latest
   docker build --build-arg API_ORIGIN=http://api:8000 -t <ecr_web>:latest ../../frontend && docker push <ecr_web>:latest
   terraform apply
   ```
4. Confirm the alarm email subscription that AWS sends you.
5. Open Secrets Manager → `<name>/integrations` and fill in the keys you have (list at the end of this page).
6. Run the migration task once (the deploy workflow does this on every deploy), then create the first admin
   with ECS Exec on an API task:
   ```bash
   aws ecs execute-command --cluster pixcart-production --task <task-id> --container api --interactive \
     --command "python -m scripts.seed"                                         # categories only
   aws ecs execute-command ... --command "python -m scripts.create_admin --email you@yourshop.in --name 'Your Name'"
   ```
   Sign in at `/admin/login`, turn on two-step sign-in under My account, and add your staff with roles.
7. In GitHub → Settings → Environments, create `production` and set the variables listed at the top of
   `.github/workflows/deploy.yml` from the Terraform outputs.

From then on, every push to `main` that passes CI builds the images, runs `alembic upgrade head` as a
one-off task, rolls out the API, then the web, and runs a smoke test. A failed rollout rolls back
automatically. To release by hand, run the Deploy workflow from the Actions tab.

## Integrations: where each key comes from

Fill these in `<name>/integrations` (Secrets Manager), then redeploy the API (or run the Deploy workflow).
Non-secret switches live in `app_env` in `terraform.tfvars`.

| Integration | Keys | Where to get them | Also |
|---|---|---|---|
| Razorpay payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Account & Settings → API keys; Webhooks | Webhook URL `https://<domain>/api/payments/razorpay/webhook`, events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`. Test with test keys first. |
| RazorpayX payouts | `RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET` | RazorpayX → Settings (account number); Webhooks | Set `PAYOUT_MODE=razorpayx`. Webhook URL `https://<domain>/api/webhooks/razorpayx`, events `payout.processed`, `payout.reversed`, `payout.failed`. Until then, payouts use the bank file and UTRs. |
| MSG91 SMS | `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID` | MSG91 → API keys; OTP template linked to your DLT template | Needs DLT registration (entity, sender ID, templates). Order SMS use MSG91 Flow IDs entered in Admin → Messages. |
| Email | `SMTP_USER`, `SMTP_PASSWORD` (+ `SMTP_HOST`, `SMTP_FROM` in `app_env`) | Amazon SES SMTP credentials (verify your domain, leave the sandbox) | `SMTP_FROM` is the sender address; the sender name is your brand name from Admin → Storefront. |
| WhatsApp | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` | Meta Business → WhatsApp Manager; a permanent system-user token | Template names go in Admin → Messages; templates must be approved by Meta. |
| Shiprocket | `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, `SHIPROCKET_WEBHOOK_TOKEN` | Shiprocket → Settings → API → create API user | Set `SHIPPING_PROVIDER=shiprocket`. Tracking webhook URL `https://<domain>/api/webhooks/shiprocket` with the token as the `x-api-key` header. |
| AI | `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | Turns AI studio from sandbox to live. Choose the model, monthly token budget and features in Admin → AI studio; usage and estimated cost are shown there. |
| Error tracking | `SENTRY_DSN` | sentry.io project settings | Optional. No personal data is sent. |

Admin → Integrations shows which are connected.

## Go-live checklist

- [ ] Admin → Overview shows the go-live checklist; work through it until it disappears.
- [ ] GST registration as an e-commerce operator (needed to collect TCS); GSTIN and legal name set in Admin → Storefront → Business, contact and social.
- [ ] TCS (0.5%) and TDS (0.1%) rates confirmed with your chartered accountant in Admin → Settings.
- [ ] Grievance officer and registered address set in Admin → Storefront → Business, contact and social.
- [ ] Terms of use, privacy notice (DPDP Act) and returns policy written by your lawyer, pasted in Admin → Storefront → Pages.
- [ ] Customer care contact details and social media links added (same tab); check `/contact`.
- [ ] Razorpay live keys and webhook tested with a real ₹1 order and refund.
- [ ] MSG91 DLT templates approved and a test OTP received.
- [ ] A test restore of an RDS snapshot done once.
- [ ] Every admin has two-step sign-in on.
- [ ] Demo data never loaded (`seed --demo` is for local use only).
