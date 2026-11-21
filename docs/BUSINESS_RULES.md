# Business rules

Rates below are defaults, editable in Admin → Settings or per category. Confirm statutory rates with a
chartered accountant before going live. This document is not legal or tax advice.

## Orders

- One customer order becomes one **sub-order per seller**. Each sub-order is shipped, cancelled, refunded and
  settled on its own.
- Sub-order states and the only allowed moves:

  ```
  pending_payment → placed | cancelled
  placed          → confirmed | cancelled
  confirmed       → packed | cancelled
  packed          → shipped | cancelled
  shipped         → delivered
  ```

  Any other move is refused in one place (`services/orders.py: transition`).
- Customers can cancel until the package ships. Sellers can cancel before shipping only with a reason
  (out of stock, PIN code not serviceable, pricing error, other). An out-of-stock cancellation also sets
  that item's stock to 0.
- **Stock** is taken when the order is created. Online orders that are not paid within 30 minutes are
  cancelled and the stock is returned. Before cancelling, the job asks Razorpay whether a payment did
  arrive, so a slow webhook never cancels a paid order.
- **Cash on delivery:** on by default, up to ₹50,000 per order, with an optional fee. A COD order counts as
  paid once every package that was not cancelled has been delivered.
- **Delivery fee:** per seller package, ₹40 unless that seller's items total at least ₹499.

## Payments and refunds

- The browser's "payment succeeded" is never trusted. The server first checks Razorpay's signature, then
  asks Razorpay for the payment and checks its order and amount. It captures the payment if it is only
  authorised.
- Webhooks are signature-checked and stored by event id, so a replayed event is ignored.
- Refunds are created in the same transaction as the cancellation. The Razorpay call runs afterwards and is
  retried every 5 minutes, up to 8 times. After that the refund appears in Admin → Refunds for a manual retry.
  Our refund id is sent as Razorpay's `receipt`, so a retry never refunds twice.
- A payment that arrives after the order was cancelled, or a second payment for an already-paid order, is
  refunded in full automatically. A second payment is refunded to itself (its own gateway payment id is kept on the
  refund); the order's first payment stays its payment, so later cancellations and returns refund it.
- Cancelling a prepaid package refunds its share (less the marketplace's coupon). When no other package of the order
  is left, the tip goes back too (always), and the marketplace's fees when "Refund these fees" is on. The cancel
  dialog shows exactly this amount.

## Money per sub-order

All amounts are integer paise and rates are basis points (100 bps = 1%). Rounding is half-up to the paisa.

| Item | Rule |
|---|---|
| Item price | GST-inclusive selling price × quantity |
| GST split | `taxable = gross × 100 / (100 + rate)`. Seller state = buyer state → CGST + SGST (half each); otherwise IGST |
| Delivery / COD fee | Taxed with the goods (composite supply) at the highest item rate in the package |
| Commission | Category rate (or the seller's override) × item price |
| GST on commission | 18% of commission (default) |
| TCS (CGST Act s.52) | 0.5% (default) of net taxable value; split CGST/SGST or IGST in the GSTR-8 report |
| TDS (Income-tax s.194-O / s.393 of the 2025 Act) | 0.1% (default) of gross amount |
| Seller payout | gross − commission − GST on commission − TCS − TDS |
| Payout date | delivery date + the longest return window among the items (as saved on the order), and never before the period for damaged, faulty or wrong items ends |

The GST on commission, TCS and TDS rates are set in Admin → Settings. The fee preview in the seller's listing
form (`GET /api/seller/fees`) uses the same rates as the payout statement, so a rate change shows there at once.

The GSTR-8 report (Admin → TCS report) lists supplier-wise net taxable value and TCS for sub-orders placed
in the month, excluding cancelled ones, less the taxable value and TCS of returns received in the month.

## Seller onboarding (KYC)

A seller must provide all of the following before submitting:

- Legal name and business type.
- A GSTIN, which must pass the check-digit test and must not belong to another seller.
- A PAN matching characters 3–12 of the GSTIN.
- A pickup address in the GSTIN's state.
- A bank account (entered twice) and IFSC.
- A grievance officer.
- PAN card, GST certificate and cancelled cheque uploads.

While an application is under review, or once it is approved, the KYC and bank details are locked. Changing
them goes through support, so a hijacked account cannot redirect payouts. PAN and account numbers are
encrypted at rest. Admin views of KYC and documents are written to the audit log.

## Listings

- New listings and **content** edits (title, description, images, category, GST, HSN, specs, return window)
  go to review. **Price and stock** edits on a live listing apply immediately.
- Each category has a return policy (Admin → Categories): the window a new listing starts with (also used for a
  blank cell in the bulk upload) and the shortest window a seller may set, up to 30 days. When staff raise the
  minimum, listings below it move up to it at once (written to the audit log); orders already placed keep their window.
- A listing is visible only when it is approved, its seller is approved, and it has an active variant.
  Suspending a seller hides all of their listings at once.
- Images must be uploaded through PixCart. They are re-encoded to WebP, which removes EXIF and GPS data.
  External image links are refused.

## Consumer Protection (E-Commerce) Rules, 2020

- The operator's legal name and grievance officer appear in the footer and on `/help/grievance`.
- Every product page shows the seller's legal name, GSTIN, location and grievance officer, plus the country
  of origin and the return window.
- Each seller must name a grievance officer during onboarding.
- Every complaint is a support ticket: it must be acknowledged within 48 hours and resolved within one
  month. The support desk shows both deadlines and flags overdue tickets; the overview counts them.
- Customers can mark a ticket as a grievance; grievances are filtered separately for the grievance officer.

## Warehouses and stock

- Each seller has a main warehouse (their pickup address) and can add more. A warehouse in another state
  needs the seller's GSTIN for that state.
- Stock is kept per warehouse. Every change (set, adjust, sale, cancellation, return, transfer) is written to
  the stock history with who did it.
- At checkout each seller's items are allocated to one warehouse if possible (same state as the customer
  first, then the main warehouse), otherwise line by line from the best warehouse that holds the whole line; a
  line no single warehouse can fill is split across warehouses, fullest first. Each warehouse becomes its own
  package, with its own invoice and tax split based on the warehouse's state; a coupon is shared between the parts.
- Only switched-on warehouses count as sellable stock; switching one off or on moves its stock out of or back into
  sale at once. The product form sets the total of sellable stock through the main warehouse.
- A seller who cancels an order as "out of stock" picks the items; their stock in that package's warehouse is set
  to 0 through a recorded stock change, so the units do not come back with the next stock movement.
- "Low stock" (shoppers' "Only N left", sellers' daily alert, filters and dashboard) means at or below the number set
  in Admin → Marketplace settings (default 5). One order holds at most the per-item limit set there.
- A lightning deal never sells more units at the deal price than the seller offered: the cart and checkout stop at
  the units left ("Only N left at the deal price"), and units of a cancelled order go back on offer while the deal runs.
- Holiday mode hides the seller's products and blocks new orders; orders already placed stay open.

## Coupons

- **Platform coupons** (admin) lower what the customer pays. The seller is still paid, and taxed, on the
  full price; the platform absorbs the discount.
- **Seller coupons** lower the seller's sale value: GST, commission, TCS and TDS are worked out on the
  discounted price, and the invoice shows the lower value.
- A discount spread over several items is split in proportion to their value, with paise rounded so the
  parts add up exactly. Limits: date window, total uses, uses per customer, first order only, minimum order,
  category. A coupon used on an order that is fully cancelled is released.

## Sponsored products (ads)

- Sellers pay per click within a daily and an optional total budget. Each finished day's spend plus GST is posted to
  the seller ledger and comes off the next payout.
- Only genuine clicks are charged. Every ad shown is an impression recorded for the shopper it was shown to (a random
  id in a first-party, HttpOnly cookie; only a keyed hash of it is stored), and its signed click link carries that
  impression's one-use code. A click is charged only on the link's first use, within 48 hours, by that shopper.
- A shopper's repeat clicks on the same product within 24 hours are free (they still count for ad sales).
- A campaign pays for at most a set number of clicks a day (India time) from one internet address and from one
  network (Admin → Advertising; 3 and 10 by default), whatever browser the clicks claim to come from. For IPv4 an
  address is one address and a network is its /24; for IPv6 an address is a /64 (one home or phone) and a network a /48.
  Addresses are stored only as keyed hashes.
- Any other click (a reused, expired or unknown link, someone the ad was not shown to, no visitor cookie, over a limit)
  still opens the product, costs nothing and counts as an invalid click in the seller's and staff's reports.
- Ad requests and clicks are rate limited per address (120 ad requests and 30 clicks a minute). Beyond that no ads are
  shown and clicks only open the product, so floods cannot inflate impressions, clicks or spend.
- These limits need the shopper's real address: behind a load balancer `TRUST_PROXY_HEADERS` must be on (the AWS setup
  does this). Without it every shopper shares the proxy's address and few clicks are charged.

## Invoices and credit notes

- An invoice is issued per package when it ships, in the seller's name and GSTIN. Numbers follow GST rule 46:
  gap-free per seller per financial year, at most 16 characters, e.g. `KOV/26-27/000001`.
- A received return produces a credit note (`KOVCN/26-27/000001`) against that invoice.
- The marketplace invoices its own fees on an order (handling, small cart, platform, bad weather, late night) under
  its GSTIN, in its own series (`MKT/26-27/000001`; prefix and SAC code in Admin → Checkout and fees), with CGST +
  SGST when the customer is in the operator's state and IGST otherwise. It is issued at the first delivery of the
  order, or when a prepaid order is fully cancelled and the marketplace keeps the fees; fees refunded on
  cancellation are never invoiced. Without a GSTIN in Admin → Storefront → Business no fee invoice is issued.

## Returns

- A customer can return eligible items within the return window the listing showed when the order was placed,
  counted from delivery. Each order item keeps that window: a later edit to the listing changes only new orders.
- An item that arrived damaged, faulty, wrong or with parts missing can be returned for that reason for a set number
  of days after delivery (Admin → Settings → Returns, 7 by default; 0 turns it off), even when the listing is not
  returnable or its own window has closed (Consumer Protection (E-Commerce) Rules 2020). Seller payouts wait for
  that period too.
- A return request lists each item once; an item named twice is counted once, with its quantities added up.
- Flow: requested → approved (or rejected with a reason) → picked up → received → refunded. Admins can step
  in at every stage; "approve returns automatically" skips the seller's approval.
- Staff with the orders permission ("Orders and returns") can open a return for a customer from the order
  (Admin → Orders → Open a return), for example when the customer calls support. The customer's own rules apply
  (windows, reasons, UPI ID for cash-on-delivery refunds); the return is the customer's, and the audit log names
  the staff member.
- On receipt: stock goes back to the warehouse, the seller's ledger is reversed for those items, a credit
  note is issued, and online payments are refunded to the original method. For cash on delivery, the
  customer gives a UPI ID and finance records the UPI reference when the refund is paid.

## Seller ledger and payouts

- When a package is delivered, the ledger gets the sale value and the deductions (commission, GST on
  commission, TCS, TDS). These become available once the return window closes.
- Cash on delivery collected by the seller's own courier (not our delivery partners, not Shiprocket) is already
  with the seller: the ledger posts it as "Cash your courier collected" at the same time as the sale, so the payout
  nets it off. The packing slip shows the exact amount to collect (the marketplace's coupon, fees and tip included).
- Returns post the reverse entries for the returned lines only: each line's own commission (its category rate), GST
  on it at the rate charged, TCS on the returned taxable value and TDS on the returned gross. The statement (with CSV
  export) shows every line. The seller dashboard's figures come from the same ledger.
- A payout run sweeps everything available per seller above the minimum payout. Manual mode produces a
  bank bulk-transfer CSV and finance records each UTR; RazorpayX mode sends the payout and confirms it by
  webhook. A failed or cancelled payout puts its own money and orders back to available.
- A payout is made out to the bank account on file when it is created, and the bank file and RazorpayX pay exactly
  that. If the seller's account changes afterwards, the payout is held (left out of the bank file, not sent) until
  Finance confirms the new account on it. Staff changing a seller's bank details confirm with their password (and
  authenticator code) and the seller is told.
- Automatic payouts are off by default and can be switched on in Admin → Settings, with the payout day
  (default Monday) and how often (every week, or every second week counted from Monday 1 January 2024).
  The job checks every day at 10:00 IST and runs only on a payout day. Sellers' Payouts page shows the
  real schedule and the next payout date, or "when the marketplace runs payouts" while automatic payouts
  are off.

## Notifications

- Order, return, refund, support and seller events create in-app notifications and, where configured,
  email, SMS and WhatsApp messages. Templates are edited in Admin → Messages.
- Messages are queued in the database and sent by a background job with retries, so a provider outage never
  blocks checkout.
- Order updates are always sent; offers only to customers who opted in.

## Personal data (DPDP Act 2023, Rules notified November 2025)

- Customers can change marketing consent, download their data and delete their account from My account.
- Deleting an account removes name, contact details, addresses and wishlist and signs the person out
  everywhere. Orders and invoices are kept, without personal details, for the period tax law requires.
- PAN and bank account numbers are encrypted in the database; KYC documents sit in a private bucket and are
  served only to the seller and to admins with the sellers permission.

## Staff access

- Six roles: owner, operations, catalogue, finance, support, marketing. Each screen and API needs a specific
  permission; the role table is in Admin → Staff and roles.
- At least one active owner always remains. Removing someone's access signs them out at once.
- Two-step sign-in (authenticator app) is available to every admin and should be on for all of them.
- Every admin action is recorded in the audit log.

## Business details, contact and social media

- Admin → Storefront → Business, contact and social holds the operator's registered name, address, GSTIN
  (checked for a valid check digit), CIN and grievance officer. Environment variables only give the first
  values on a new install.
- Contact details are a list (email, phone, WhatsApp, address, link, note) and social media is a list of
  platforms (preset icons or an uploaded icon for any other platform). Each item can be reordered or hidden,
  and each module can be switched off. Footer toggles choose what the footer shows; the copyright line can use
  {year}, {legal_name} and {brand}.
- Where they are used: footer, `/contact`, `/help/grievance`, every email (sender name and footer), the
  operator line on invoices, the Razorpay payment window, authenticator app labels, payout narrations and the
  schema.org data search engines read.
- Safety: social links must be https addresses; links must start with `/` or `https://`; emails and phone
  numbers are validated; text is stored as plain text and never rendered as HTML; at most 12 social links and
  10 contact details.
- Storefront text can use {brand} and {free_delivery_amount}, so copy stays right when settings change.
- The admin overview shows a go-live checklist (legal details, policies, payments, SMS, two-step sign-in)
  until everything is done.

## Exports

- Admin → Exports and Seller hub → Reports and exports. Admins see only the exports their role allows;
  sellers' exports are always limited to their own rows.
- Date ranges are whole days in Indian time, at most 366 days per file (default: the last 30 days). Sellers
  and customers registers cover all dates unless a range is chosen. GSTR-8 is per month.
- Files: UTF-8 with a byte-order mark, comma separated, money in rupees with two decimals. Text that a
  spreadsheet would run as a formula is prefixed with an apostrophe.
- Exports stream in batches of 1,000 rows, so large files do not load into memory. Each person can start 30
  exports per 10 minutes. Every export is recorded in the audit log with its filters.
- The stock export's first three columns (sku, warehouse_code, quantity) are the stock import format.

## AI features

- AI never acts on its own: every draft is shown to a person who edits, uses, sends or discards it. Listing
  drafts fill the form; support replies fill the reply box; customer messages are sent only after review.
- The model receives three layers: fixed rules per feature (safety and format, not editable), a brand block
  (name, operator, brand voice, customer-care contact, extra instructions from AI studio), and the request.
  The first two are marked for prompt caching. Only facts the feature needs are sent: first names, order and
  ticket details, never phone numbers, emails, addresses or payment data from the account.
- Each run is stored (feature, who, outcome, model, input/output/cache tokens, latency, error) and can be
  exported. Failed runs are kept too. Provider errors are retried once.
- Limits: 40 AI drafts per person per hour; an optional monthly token budget stops AI until next month when
  used up; the master switch and each feature switch take effect at once.
- Without an API key (or in tests) the pipeline runs in sandbox mode with obviously marked placeholder text.
  Review summaries are published on product pages, so they are written only in live mode.
- Listing checks always include rule-based findings (restricted items, contact details in the text,
  discounts above 80%, very short descriptions); the AI can raise the risk level but never hide those.
- Risk briefs are rule-based scores from 0 to 100 (green under 30, amber under 60, red otherwise) with every
  contributing factor listed. Orders: large COD value, brand-new account, first order, earlier cancellations
  and returns, undelivered shipments to the same PIN code. Sellers (last 90 days): seller cancellations,
  late shipping, returns, low rating, rejected listings, recently approved.

## Bulk listing upload

- Sellers download the template, fill one row per SKU, and upload a CSV. Rows with the same product_key form
  one product; options use option_1/option_2 columns. The category is a sub-category name or path.
- The file is checked first (dry run) and every problem is shown with its row. Creating saves only the
  valid products, as drafts; sellers then add photos and submit them for review as usual.
- Limits: 2 MB, 2,000 rows, 300 products per file, 30 uploads per hour. SKUs already in the catalogue or used
  twice in the file are refused, so uploading the same file twice never duplicates products.
