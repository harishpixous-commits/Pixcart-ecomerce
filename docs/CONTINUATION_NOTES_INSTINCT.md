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
