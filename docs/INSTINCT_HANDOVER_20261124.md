# Instinct rebuild handover - 2026-11-24 08:15 IST

Branch: `instinct/port-commerce` (base: `dotnet-angular`). HEAD at writing: see git log.
Everything below was run on a local machine against a local MySQL 8.4 and a loopback Razorpay
mock. No production system, live provider, or paid service was touched.

## How to run what exists

```bash
# Database: MySQL 8.4 on port 3307, user/password pixcart/pixcart, schema pixcart
# (schema applied from the branch's migration files earlier in the session)

# API (from repo root):
cd PixCartAPI/API
App__RazorpayKeyId=mock_key App__RazorpayKeySecret=mock_secret \
App__RazorpayApiBase=http://127.0.0.1:8599/v1 App__JobsRunAtStartup=true \
dotnet run --urls http://127.0.0.1:5080
# health: curl http://127.0.0.1:5080/api/health  -> {"ok":true}

# Web skeleton (currently the untouched Angular starter, see "Frontend state"):
cd PixCartWeb && npm ci && npx ng build   # verified building 2026-11-24
npx ng serve                              # or serve dist/PixCartWeb/browser statically
```

## Backend state (.NET 10 + Dapper + MySQL)

Ported module by module from the live FastAPI reference (`main` branch, never modified):
commerce, seller, delivery/fleet, admin ops, refunds/returns, platform settings,
assistant (sandbox ask engine), AI scaffolding with fake providers only, background jobs
(local fakes/recording transports only).

Assistant admin actions: all 19 kinds are WIRED (registry + prepare branch + dispatch).
They are NOT all verified end-to-end: the sandbox ask engine has no natural-language path
to the newest kinds, so prepare for create_coupon / set_coupon_active / moderate_review /
reply_ticket / set_announcement is compile-verified only; their dispatch paths were exercised
through the decide endpoint with pending rows inserted in prepare's exact output shape.
The decide endpoint itself (confirm/cancel/expired/failed/already-done/422) is fully
runtime-verified.

Runtime-verified this session (local MySQL + locally minted admin JWT):
- Platform coupon create/update (duplicate code 409, invalid percent rejected, code
  preserved on update, seller-funded category kept, audit coupon.create/coupon.update).
- Review moderation publish/hide/publish-media/hide-media/dismiss-reports with report
  close-out (dismissed/upheld) and product+seller rating refresh; audit review.{action}.
- Support ticket view + staff reply (public reply acks + moves to awaiting_customer +
  ticket_reply notification; internal note; resolved/closed sets resolved_at; assigned_to).
  Fixed: ticket_reply in-app template was missing from CatalogNotifyBAL.InApp (silent skip).
- set_announcement dispatch via decide (site document merged, tone preserved, audit
  storefront.announcement/settings/site/assistant).
- staff-deliver success branch (fleet trip closed: COD counted as cash, fee from distance,
  status log + audit suborder.admin_deliver).
- run_payouts dispatch (done, created: 0 with no balances due).

## Frontend state (Angular) - parity NOT started

`PixCartWeb` is the untouched foundation-commit skeleton: it builds (`npx ng build`
verified) and serves the default Angular starter page ("Hello, PixCartWeb"). It contains
no PixCart storefront/seller/admin UI. Screenshot evidence:
pixcartweb-skeleton-20261124.png (sent with the handover report).
Angular pixel parity at 390/768/1366 has not begun.

## Mobile state (Flutter) - NOT started

`mobile/` (partner-app, shop-app, shared) is the foundation-commit skeleton, unmodified
and unbuilt in this session.

## Open items / honest gaps

- Customer auth is now PORTED and runtime-verified (2026-11-24 08:19 slice): otp request
  (purpose checks, cooldown, per-phone/per-IP limits, dev-OTP in test mode only), otp verify
  (attempts counter, signup validation, account creation, session issue), password login
  (lockout limits, totp_required/totp verify), change password (revokes sessions), TOTP
  setup/enable/disable, refresh rotation, logout, sessions list, sign-out-others, me/update_me.
  NOT yet exercised: the refresh theft-replay branch and the 60-second grace-window renew
  branch. In-app notifications only for security notices (reference also emails/SMSes).
- The storefront catalog HTTP surface is UNPORTED - no controllers exist for it yet (only
  cart/checkout/orders on the customer side). This is a missing surface, not merely an
  unverified one.
- Credit-note numbering collision quirk: the 16-char truncation collision is preserved
  temporarily but UNRESOLVED; it is not an accepted defect, and the reference numbering
  contract stays unchanged unless Harish decides otherwise.
- Online-return refund (mock provider path) and staff return auto-assign success branch:
  declared earlier, still not exercised with a fixture.
- run_payouts with actual balances due (nonzero created count) unexercised.
- PrepareAsync / propose_action tool handler: compile-verified only.
- All provider calls (payments, LLM, dispatch) are mock-only by design; true integration
  needs Harish's approval plus test keys.
- 5 flow videos and full Playwright e2e against the rebuilt stack: not done.

## Recovery

Git bundles of the full branch history were captured after each verified slice
(pixcart-recovery-20261124-*.bundle, sha256 recorded in the session log and reports).
Latest bundle covers HEAD at handover time.
