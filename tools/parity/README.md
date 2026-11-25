# Parity tools: the .NET + Angular version against the Python reference

The reference (Python API + Next.js site) and this version must behave and look the same. These tools compare them on
the same data. Copy the reference's demo data into MySQL first with `tools/DataMigrator`, then run the API on that copy.

| Tool | What it compares |
|---|---|
| `compare.cjs` | Screens, pixel for pixel: the same route on both sites at the given widths and themes (`node compare.cjs --help` in the header). |
| `api_diff.py` | Every GET route of the reference, called on both APIs as guest, customer, seller, partner and admin: status codes and JSON. |
| `body_diff.py` | Validation: every POST/PUT/PATCH with required body fields, sent an empty body: status, error code, message and fields. |
| `scenario_diff.py` | The full cash-on-delivery journey through the API: sign-up, address, cart, quote, order, seller confirm/pack/ship/deliver, return, approve, receive, refund. |
| `payment_scenario.py` | Online payment through the local Razorpay simulator: paid now, failed, and approved later in the UPI app (webhooks, verify, payment status, return from the UPI app). |

Generated values (ids, order/return/invoice numbers, times, tokens) are normalised; everything else must be equal.
A few lists have no defined order in the reference (rows with equal sort values, queries without ORDER BY); those can
differ in order and are not bugs.

```
python -I api_diff.py http://127.0.0.1:8100 http://127.0.0.1:5180 ../../PixCartAPI/API/Infrastructure/route-guards.json <admin-password-file> out.txt
python -I body_diff.py http://127.0.0.1:8100 http://127.0.0.1:5180 body-required.json ../../PixCartAPI/API/Infrastructure/route-guards.json <admin-password-file> out.txt
python -I scenario_diff.py http://127.0.0.1:8100 http://127.0.0.1:5180 <admin-password-file> out.txt
python -I payment_scenario.py http://127.0.0.1:8100 http://127.0.0.1:5180 out.txt
```

The demo accounts' sign-ins are rate-limited; `api_diff.py` and `body_diff.py` keep their tokens for 10 minutes in
`token-cache.json` next to them (ignored by git). Never put a password in a file in this repository.
