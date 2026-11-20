# Own delivery fleet, checkout fees and push notifications

PixCart can deliver with its own delivery partners (like Swiggy Instamart or Flipkart's own fleet) alongside courier
shipping. Everything here is set up and run from the admin panel; nothing needs a code change.

## Set it up (admin)

1. **Delivery zones** (Admin → Delivery fleet → Delivery zones): name, city and the PIN codes each team covers.
   A package goes to the fleet when the seller's warehouse and the customer are in zones of the same city.
2. **Partners** sign up themselves at `/delivery/join` (mobile OTP, photo, vehicle, driving licence, ID proof with only
   the last 4 Aadhaar digits kept, bank or UPI). Staff can also add a partner by mobile number. Review them in
   **Delivery partners**: open the documents, approve into a zone or ask for changes; the partner is told.
3. **Delivery settings**: which orders the fleet carries (zones only, every order, seller chooses, couriers only),
   auto-assign on or off, how long a partner has to accept (seconds), search radius, most trips at once, partner fee
   (fixed, or base + per km with a minimum and maximum), most cash a partner may hold, whether held cash comes off the
   weekly payout, pickup code, customer OTP and delivery photo switches, the "stuck" alert time, location sharing
   interval, map tiles, support phone and WhatsApp, and the partner Android app.
4. **Firebase** (Admin → Integrations → Firebase) for push notifications: service account (project id, client email,
   private key) and the web app keys (API key, sender id, app id, VAPID key). Test connection checks the key.

## How an order is delivered

1. The seller confirms the order and taps **Ready for pickup** on the order page (or packs it first). They see a
   4-digit **pickup code** and, once assigned, the partner's name, vehicle and phone.
2. **Auto-assign** offers the package to the nearest free, online partner of the zone (location fresh, under the trip
   and cash limits). The request pops up full screen on the partner's phone with a countdown, a chime and vibration, and
   arrives as a push notification when the app is closed. No answer in time, or Reject (with a reason), moves it to the
   next partner; when nobody is left, staff are alerted and the package waits in **Assign deliveries**.
   With auto-assign off, staff pick a partner there: candidates are ranked with distance, trips, cash and rating,
   and staff can ask (the partner accepts) or assign directly, and override a warning.
3. The partner goes to the store (Google Maps directions), taps **I have reached the store**, checks the items and
   enters the seller's pickup code; the order becomes *Shipped* and the customer is told, with the **delivery OTP**.
4. **Start the trip**: the customer's order page shows the partner, a live map and the OTP. **I have arrived** sends
   the customer a notification.
5. **Hand over**: the partner enters the customer's OTP, the cash collected (exactly the amount due, cash or UPI) for
   cash on delivery, and a photo of the package. The order is *Delivered*; the partner earns the fee plus the tip, plus
   the **bad weather bonus** (Delivery settings → Partner earnings) when the trip ends while the bad weather fee is on.
6. The customer rates the partner (1 to 5 stars) or reports a problem; staff see both in **Ratings and complaints**.

**Could not deliver** (customer not available, wrong address, refused, no cash, damaged, other) keeps the package with
the partner; staff choose **Try again** or **Bring back to store** (Assign deliveries → Not delivered). A package
brought back is handed to the seller with the pickup code; the order part is cancelled, a prepaid amount refunded and
the stock returned. Cancelling an order before pickup stops the trip; after pickup the partner is told to bring it back.

## Returns collected by a partner

For a package our partners delivered, approving the customer's return asks a partner to collect it (switch:
Delivery settings → *Partners collect customers' returns*). The customer gets a 4-digit **pickup code** on the return
card and by notification. The request is offered like a delivery (auto-assign to the nearest free partner of the
customer's zone, or by staff in **Assign deliveries → Return pickups**, where staff can also hand it to the seller's
own courier). The partner goes to the customer, checks the items, enters the customer's code (the return becomes
*Picked up*), brings it to the store and enters the **seller's pickup code** shown on the seller's Returns page. The seller
checks the item and marks the return received, which puts the stock back, issues the credit note and refunds the
customer. The partner earns the delivery fee for the pickup. "Could not collect" (customer away, item not ready,
refused) puts the return back in the Return pickups list for another try.

## Watching the fleet

- **Live partners**: who is online now (free, on a trip, location live or old), how long online, trips in progress,
  today's deliveries and earnings, cash in hand against the limit, rating; all on a live map with stores and customers.
  Updates every 10 seconds.
- **Stuck trips**: a trip in the same step longer than the set minutes alerts staff (push and in-app).
- **Trips**: every request and trip by status, with the full log (who, when, where), money and the delivery photo.
- **Payouts and cash**: weekly payouts are created every Monday for the week before (or on demand for any week);
  pay from the bank and mark paid with the reference (the partner is told). Cash held by partners is listed with a
  *Record deposit* button.
- **Reports**: deliveries and failures per day, success rate, cash collected, and each partner's numbers (CSV).

## The partner app

- Web: `/delivery` on any phone browser; installs to the home screen as its own app (manifest and icons follow the
  storefront brand). Location is shared only while online or carrying a package.
- Android: `mobile/partner-app` (Capacitor). Build it with **GitHub Actions → Android partner app**, then upload the
  APK in Delivery settings → Partner Android app; partners download it from `/delivery/download`. Details and
  signing in `mobile/partner-app/README.md`.

## Checkout fees and the bill

Admin → **Checkout and fees** sets the delivery fee per seller package and the free-delivery amount, cash on delivery
(on/off, fee, largest order), and optional **handling**, **small cart** (below an amount) and **platform** fees, each
with its label and the text shoppers see, GST included in the fees, a refund of the fees when the whole order is
cancelled, the **tip** for the delivery partner (preset amounts and maximum), **GSTIN** for business purchases, delivery
instructions, "no bag", and the cancellation note. A live preview shows the bill for a sample order. Shoppers see the
same bill (item total, each fee with its explanation, savings, To pay) in the cart, at checkout and on the order.

Two time-bound fees, like Instamart's:

- **Bad weather fee** (rename it, e.g. "Rain fee"): switch it on during heavy rain or very high demand for 1 to 24
  hours from saving, or until you switch it off; it stops by itself at the end and the page says when. Partners see a
  "Bad weather bonus" banner and earn the bonus on every trip they finish meanwhile.
- **Late night fee**: on orders placed inside a window in India time (default 11 pm to 6 am; it may cross midnight).
  The preview has a "Placed late at night" box to see that bill at any time of day.

If a time-bound fee starts or ends while a shopper is at checkout, the order is refused with "Prices changed" and the
new bill is shown, so nobody pays an amount they did not see.

## Push notifications

Every notification (order updates, delivery steps, payouts, staff alerts) also goes out as a push to the devices where
the person turned notifications on: partners in the partner app, shoppers on their order page, sellers on the seller
dashboard, staff on the delivery overview. A new delivery request is sent as urgent (sound and vibration until seen).
Tokens are removed when someone signs out, and dead tokens are dropped automatically.

## For developers

- Backend: `app/services/fleet.py` (routing, offers, trips, payouts), `app/services/delivery_settings.py`,
  `app/routers/delivery.py` (partner), `app/routers/delivery_admin.py` (staff), `app/services/fees.py` (bill),
  `app/services/push.py` and `app/routers/push.py`; jobs in `app/jobs.py` (request expiry every 10 s, stuck check every
  minute, weekly payouts on Monday 04:45 UTC). Tests: `tests/test_delivery.py`, `tests/test_checkout_fees.py`,
  `tests/test_push.py`.
- Frontend: `src/app/delivery` (partner app), `src/app/admin/delivery`, `src/components/delivery` (feed and request
  popup, trip pieces, tracking card), `src/components/map` (Leaflet on OpenStreetMap), `src/lib/push.ts` and
  `src/app/push-sw.js/route.ts` (service worker).
- End to end: `e2e/tests/delivery.spec.ts` runs the whole flow in browsers.
