# Continuation notes (second agent) - started 2026-11-27 evening IST

Branch: `instinct/continue`, cut from `port/company` at 29d57e6. Nothing here touches `main`, the live site or the
company repositories. Work is pushed to `instinct/*` branches only.

## Division of work (so slices are not done twice)
- This agent takes the backend review slices in the order of `tools/agent-briefs/review-backend-sequential.js`.
  Next to be taken: the slice after the last one listed below. Claude should not start a slice listed here as
  "in progress" or "done". If Claude has already started one, write it in section 6 of CONTINUE_HERE.md and this
  agent will skip it.
- Claude keeps what needs the Windows machine: browser suite, pixel compare, publish package, order flow, Flutter.

## Slice log
| Slice | State | Result |
|---|---|---|
| returns-refunds-invoices | reviewed (read-only comparison of services/returns.py, ledger.post_return, invoices.py, the customer, seller and admin return routes against ReturnsBAL, InvoicesBAL, ReturnsDAL) | No behavioural difference found in the state machine, the amounts, the ledger reversal, the credit-note numbering (both truncate to 16 characters), the restock rule or the refund row. One cosmetic difference: the credit note's customer cell prints "City, State" in Python even with an empty state; .NET drops the trailing comma. Not changed. |

## Environment notes for a Linux agent
- .NET 10 SDK installs to the home folder with dot.net/v1/dotnet-install.sh; MySQL 8.4 from the tar.xz on dev.mysql.com
  needs libaio (extract the .deb into the home folder and set LD_LIBRARY_PATH). Port 3307, user root, password pixcart,
  as the tests expect. A background MySQL dies when the shell call ends, so start it in the same command as the tests.
- Build: 0 warnings, 0 errors at 29d57e6. Focused run of DeliveryTrackingTests: 3 of 3 pass.

## Advanced work log (see docs/INSTINCT_ROADMAP.md)
- 27 Nov 20:34 .NET: Admin -> Growth settings + seller scorecard (IGrowthBAL/GrowthBAL, AdminGrowthController, GrowthTests). Same endpoints and defaults as Python `instinct/python-advanced` 1175d98. Guards declared with [RouteGuard] (no reference rows). Settings only; module behaviours are not wired yet in either version. Angular admin page: done (admin/pages/growth.page.ts, menu "Growth", type-checked with ngc; not run in a browser).
- 27 Nov 20:43 .NET: loyalty points EARN + balance + staff adjust (V005 script, BAL/LoyaltyPoints.cs hooked into the delivered transition in OrdersBAL, GET /api/loyalty, POST /api/admin/growth/loyalty/adjust). Mirror of Python instinct/python-advanced 28633e7. The earn rule is tested at the service level (FK checks off in the test) and the delivery tests still pass; a full buy-to-delivered run with points is not tested in .NET. NOT done: redeem at checkout, reversal on return, expiry, Angular account/checkout display, Flutter.
- 27 Nov 20:45 .NET: sitemap and robots from the API (GET /sitemap.xml, /robots.txt, /api/seo/sitemap.xml), honouring Growth -> Search engines. Mirror of Python 6094b11. Product list in the sitemap is approved listings only (same rule both sides). Hosting: when the API serves the Angular build these routes win over the SPA fallback (WebsiteHost tests still pass); behind a separate web server, route /sitemap.xml and /robots.txt to the API.
- 27 Nov 20:47 .NET: COD risk rules at checkout (BAL/CodRisk.cs, hooked in PlaceOrderAsync next to cod_limit; error code cod_risk). Mirror of Python dcfa6c9. The rules are tested as a service, and the checkout and order tests still pass. block_after_refused is a saved setting but not enforced in either version (no refused-delivery record exists yet).
- 27 Nov 20:49 .NET: seller's own scorecard GET /api/seller/scorecard (approved sellers; off until Growth -> Seller scorecard is on). Mirror of Python. Seller portal screen (Angular/Next) NOT built yet.
- 27 Nov 20:50 Angular: Seller -> Quality page (menu Customers/Quality), type-checked with ngc, not run in a browser.
