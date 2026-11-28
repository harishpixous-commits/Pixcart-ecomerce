# AI agents: what works today (honest status)

Rule for this file: "Working" means the code exists AND an automated test ran it green. Everything else is under "Not built".
All agents run on plain rules over real database queries. No paid or live AI provider is called. Nothing runs without an owner pressing Approve.
Both versions get every agent: Python (`instinct/python-advanced`) and .NET/Angular (`instinct/continue`).

## How agents work (Admin -> AI agents)
- A master switch and one switch per agent. All off by default.
- A background job (every 30 minutes) lets each switched-on agent scan and write proposals. "Run now" does it on demand.
- A proposal is a card: what the agent noticed, why, and what will happen. Staff press Approve or Reject.
- Approve runs the same admin code as doing it by hand (notifications, refunds, audit log). The role must hold the permission the action needs.
- The same idea is never proposed twice, even after a rejection. Pending proposals expire after a set number of hours. If the package changed before approval, nothing is done and the card says so.

## Working and tested

| Agent | Python | .NET + Angular | What it does |
|---|---|---|---|
| Sourcing and reorder | yes (`tests/test_agents.py`) | yes (`Reorder_agent...` in CheckoutRulesTests; Angular type-checked only) | Compares each live item's stock with its recent sales rate. If it would run out within the cover period, proposes asking the seller to restock, with a suggested quantity. Approve sends the seller an in-app note and email. |
| Order update | yes (`tests/test_agents.py`) | yes (`Order_update_agent...` in CheckoutRulesTests; Angular type-checked only) | Finds packages on their way that are past the promised delivery date and proposes a plain delay message to the customer (in-app and email). Says only what is true: it was due, it has not arrived. No new date promised. |
| Delivery and shipping | yes (`tests/test_agents.py`) | yes (`Delivery_agent_writes_proposals...` in CheckoutRulesTests; Angular type-checked only, never run in a browser) | Finds confirmed packages not shipped after N hours: proposes a seller reminder. Much later: proposes cancel and refund. Shipped with no tracking: proposes asking the seller for it. |

Also working from before (not part of the proposal queue): admin business assistant (26 read tools, 20 Confirm-gated actions), customer shop assistant, AI task library (listing writer, listing check, review summary, support reply, customer message, review reply, business brief), seller and order risk scores. All answer from real queries or templates in sandbox mode.

## Not built yet
- Order update agent: no live courier tracking, so it works from the promised date only.
- Sourcing and reorder agent: does not buy stock or raise purchase orders (sellers own their stock); uses a recent average, no seasonality.
- Marketing agent.
- Listing and support drafts feeding the same approval queue.
- Delivery agent: no courier calls, no pickup re-booking, no live tracking events.
- Any live AI model. Every agent today is rule-based.

## Marketing agent (Python: working and tested)
Key `marketing`. Finds categories with live stock but few recent sales and proposes a time-limited category coupon; approving creates the coupon through the same fields as the admin Coupons page, audited. Test: tests/test_agents.py (5 green). Not built: emails or ads, customer targeting, measuring results. .NET version: pending.

## Listing review agent and Support agent (Python: working and tested)
Listing (`listing`): runs the listing rules on pending products; proposes approve for clean ones and send-back with exact reasons for the rest; approval uses the normal admin approve/reject. Support (`support`): drafts a first acknowledging reply for open tickets unanswered for N hours; approval sends it as staff. Both rule based, no AI model, tested (7 green). Not done: photos, brand checks, refund decisions, follow-up answers. .NET versions pending.

## Test status (28 Nov, after Push 145)
Full Python suite: 323 passed. .NET full suite: see the instinct/continue copy of this file.

## Business assistant (Python: working and tested)
Key `assistant`. Once a week proposes a digest: sales for the last N days against the N before, items with few units left, tickets nobody answered, listings waiting for review. Approving sends it to the person who approved, in-app and by email. Counts only: no explanation of why, no forecast, goes to the approver only. Test: tests/test_agents.py (8 green). Note on test counts: earlier "573" and "579" .NET figures were sums of overlapping filter groups; the true single-run count is 392 before this push. .NET version: pending.
