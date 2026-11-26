/*
 * Video: the full order journey. Customer buys -> seller confirms and hands over -> delivery partner delivers ->
 * customer rates -> admin sees it. MODE=web (computer screens; the partner on a phone) or MODE=mobile (all phones).
 *   node journey.cjs <recDir> web|mobile
 */
const path = require("path");
const fs = require("fs");
const { Recorder, tap, type, scroll, top, go, otpSignIn, apiAs, sleep } = require("./rec.cjs");

const MODE = process.argv[3] || "web";
const M = MODE === "mobile";
const PRODUCT = "portable-bluetooth-speaker-20w-waterproof";
const STORE = { latitude: 12.9301, longitude: 77.6232 };
const PROOF = path.join(process.env.MEDIA_DIR, "products", fs.readdirSync(path.join(process.env.MEDIA_DIR, "products")).find((f) => f.endsWith(".webp")));
const TOTAL = M ? 16 : 18;
let n = 0;
const step = () => `Step ${++n} of ${TOTAL}`;

(async () => {
  // the demo customer starts with no saved address, so the video shows adding one
  {
    const c = await apiAs("9999900001", "Demo Customer");
    for (const a of await c.get("/api/addresses")) await c.del(`/api/addresses/${a.id}`);
    await c.dispose();
  }
  const r = new Recorder(`journey-${MODE}`, process.argv[2]);
  await r.start();
  const customer = await r.page("customer", "customer", { mobile: M });
  const seller = await r.page("seller", "seller", { mobile: M });
  const partner = await r.page("partner", "partner", { mobile: true, geolocation: STORE });
  const admin = M ? null : await r.page("admin", "admin");

  // ---------------------------------------------------------------- customer shops
  r.card("1. The customer shops", "Browse, search, choose a product, add to cart and place the order");
  await r.scene("customer", "home", async (p) => {
    await go(p, "/");
    await r.cap("customer", "The customer opens the shop: banners, deals and bestsellers", step());
    await sleep(1800);
    await scroll(p, M ? 900 : 700, 1200);
    await scroll(p, M ? 900 : 700, 1200);
    await top(p);
  });
  await r.scene("customer", "search", async (p) => {
    await r.cap("customer", "Searches for a Bluetooth speaker", step());
    const box = p.locator("#site-search");
    if (!(await box.isVisible())) await tap(p, p.getByRole("button", { name: /search/i }).first());
    await type(p, box, "bluetooth speaker", { delay: 80 });
    await sleep(800);
    await box.press("Enter");
    await p.waitForURL(/\/search/);
    await sleep(2200);
    await scroll(p, 400, 1200);
  });
  await r.scene("customer", "product", async (p) => {
    await r.cap("customer", "Opens the product: photos, price, offers, delivery date and seller", step());
    await tap(p, p.getByText("Portable Bluetooth Speaker 20W Waterproof").first(), { after: 2500 });
    await p.waitForURL(new RegExp(PRODUCT), { timeout: 60000 });
    await p.waitForLoadState("networkidle");
    await sleep(1500);
    await scroll(p, M ? 700 : 500, 1500);
    await scroll(p, M ? 900 : 600, 1500);
    await top(p);
  });
  await r.scene("customer", "cart", async (p) => {
    await r.cap("customer", "Adds it to the cart and opens the cart", step());
    await tap(p, p.getByRole("button", { name: "Add to cart", exact: true }).first(), { after: 1800 });
    await go(p, "/cart", 1800);
    await scroll(p, 300, 1200);
  });
  await r.scene("customer", "signin", async (p) => {
    await r.cap("customer", "Signs in with a mobile number and a one-time code", step());
    await tap(p, p.getByText("Sign in to place order").first(), { after: 1500 });
    await p.waitForURL(/\/login/);
    await otpSignIn(p, "9999900001");
    await p.waitForURL(/\/checkout/, { timeout: 60000 });
    await sleep(1500);
  });
  await r.scene("customer", "address", async (p) => {
    await r.cap("customer", "Adds the delivery address (the state fills in from the PIN code)", step());
    await p.getByLabel("Full name").waitFor({ timeout: 8000 }).catch(() => {});
    if (!(await p.getByLabel("Full name").isVisible())) { await sleep(2000); return; } // an address is already saved
    await type(p, p.getByLabel("Full name"), "Demo Customer");
    await type(p, p.locator("input[autocomplete=tel-national]"), "9999900001");
    await type(p, p.locator("input[autocomplete=address-line1]"), "22, 5th Cross, 4th Block, Koramangala");
    await type(p, p.locator("input[autocomplete=postal-code]"), "560034");
    await sleep(1200);
    await type(p, p.locator("input[autocomplete=address-level2]"), "Bengaluru");
    await tap(p, p.getByRole("button", { name: "Save address" }), { after: 2000 });
    await p.getByText("Review items").first().waitFor({ timeout: 30000 });
  });
  let orderUrl = "";
  let orderNo = "";
  await r.scene("customer", "place", async (p) => {
    await r.cap("customer", "Chooses cash on delivery, checks the bill and places the order", step());
    await scroll(p, 400, 1000);
    await tap(p, p.getByText("Cash on delivery", { exact: true }).first());
    await scroll(p, 500, 1200);
    const slider = p.getByRole("button", { name: "Slide to place order" });
    if (await slider.isVisible().catch(() => false)) {
      // phones: slide the handle all the way across (a tap is not enough, on purpose)
      const box = await slider.boundingBox();
      const y = box.y + box.height / 2;
      await p.mouse.move(box.x + 28, y, { steps: 12 });
      await sleep(400);
      await p.mouse.down();
      await p.mouse.move(box.x + box.width - 12, y, { steps: 35 });
      await p.mouse.up();
      await sleep(1000);
    } else {
      await tap(p, p.getByRole("button", { name: "Place order" }), { after: 1000 });
    }
    await p.getByText("Package 1 of 1").first().waitFor({ timeout: 60000 });
    orderUrl = p.url();
    orderNo = ((await p.locator("h1").first().textContent()) || "").replace("Order", "").trim();
    await r.cap("customer", `Order placed: ${orderNo}. The customer can follow every step here`, `Step ${n} of ${TOTAL}`);
    await sleep(2500);
    await scroll(p, 400, 1500);
  });

  // ---------------------------------------------------------------- partner goes online
  r.card("2. The delivery partner goes online", "On their phone, in the delivery partner app");
  await r.scene("partner", "online", async (p) => {
    await go(p, "/delivery/login");
    await r.cap("partner", "The delivery partner signs in to the partner app", step());
    await otpSignIn(p, "7300000001");
    await p.getByTestId("partner-home").waitFor({ timeout: 60000 });
    await sleep(1200);
    await r.cap("partner", "Goes online and shares location, then waits for requests", `Step ${n} of ${TOTAL}`);
    const sw = p.locator("[data-testid=partner-home] [data-testid=online-switch]");
    if ((await sw.getAttribute("aria-checked")) !== "true") await tap(p, sw, { after: 1500 });
    await p.getByText("Location is on").waitFor({ timeout: 30000 });
    await sleep(2000);
  });

  // ---------------------------------------------------------------- seller accepts
  r.card("3. The seller accepts the order", "In the seller hub");
  let pickupCode = "";
  await r.scene("seller", "signin", async (p) => {
    await go(p, "/login?next=/seller");
    await r.cap("seller", "The seller signs in to the seller hub and sees the new order", step());
    await otpSignIn(p, "9000000002");
    await p.waitForURL((u) => u.pathname === "/seller", { timeout: 60000 });
    await sleep(2500);
  });
  await r.scene("seller", "confirm", async (p) => {
    await r.cap("seller", "Opens the order and confirms it", step());
    await go(p, "/seller/orders", 1500);
    await tap(p, p.locator("a[href^='/seller/orders/']", { hasText: orderNo }).first(), { after: 2000 });
    await scroll(p, 300, 1000);
    await tap(p, p.getByRole("button", { name: "Confirm order" }), { after: 2000 });
    await r.cap("seller", "Packs it and taps Ready for pickup: our delivery partner is called", step());
    await tap(p, p.getByTestId("ready-for-pickup"), { after: 1500 });
    await p.getByTestId("fleet-card").waitFor();
    pickupCode = ((await p.getByTestId("pickup-code-seller").textContent()) || "").trim();
    await p.getByTestId("fleet-card").scrollIntoViewIfNeeded();
    await r.cap("seller", `The pickup code ${pickupCode} is shown to the seller, to check the partner at handover`, `Step ${n} of ${TOTAL}`);
    await sleep(3000);
  });

  // ---------------------------------------------------------------- partner delivers
  await partner.getByTestId("offer-popup").waitFor({ timeout: 60000 });
  r.card("4. The delivery partner delivers", "Request, pickup, ride, handover");
  await r.scene("partner", "offer", async (p) => {
    await r.cap("partner", "A new delivery request pops up with the pickup, drop and earning", step());
    await sleep(2500);
    await tap(p, p.getByTestId("offer-accept"), { after: 1500 });
    await p.getByTestId("trip-page").waitFor({ timeout: 90000 });
    await sleep(2000);
  });
  await r.scene("partner", "pickup", async (p) => {
    await r.cap("partner", "At the store, enters the seller's pickup code and collects the parcel", step());
    await tap(p, p.getByTestId("step-at-store"), { after: 1200 });
    await type(p, p.getByTestId("pickup-code"), pickupCode, { delay: 160 });
    await tap(p, p.getByTestId("step-picked"), { after: 1500 });
    await r.cap("partner", "Starts the ride to the customer", `Step ${n} of ${TOTAL}`);
    await tap(p, p.getByTestId("step-on-the-way"), { after: 2000 });
  });
  let otp = "";
  await r.scene("customer", "tracking", async (p) => {
    await go(p, orderUrl.replace(/^https?:\/\/[^/]+/, ""), 1500);
    await r.cap("customer", "The customer sees the partner on the way and a 4-digit delivery code", step());
    await p.getByTestId("delivery-tracking").scrollIntoViewIfNeeded();
    otp = ((await p.locator("[data-testid=delivery-otp-customer] .font-mono").textContent()) || "").trim();
    await sleep(3500);
  });
  await r.scene("partner", "handover", async (p) => {
    await r.cap("partner", "At the door: enters the customer's code, collects the cash, takes a photo", step());
    await tap(p, p.getByTestId("step-reached"), { after: 1200 });
    await type(p, p.getByTestId("delivery-otp"), otp, { delay: 160 });
    const due = (await p.getByTestId("cod-amount").getAttribute("placeholder")) || "";
    await tap(p, p.getByTestId("cod-cash"));
    await type(p, p.getByTestId("cod-amount"), due.replace(/[^\d.]/g, ""), { delay: 90 });
    await p.getByTestId("proof-photo").setInputFiles(PROOF);
    await sleep(1500);
    await r.cap("partner", "Marks it delivered: the trip and the earning are recorded", `Step ${n} of ${TOTAL}`);
    await tap(p, p.getByTestId("mark-delivered"), { after: 1500 });
    await p.getByTestId("trip-done").waitFor({ timeout: 30000 });
    await sleep(2500);
  });

  // ---------------------------------------------------------------- customer rates
  r.card("5. Delivered", "The customer rates the delivery");
  await r.scene("customer", "rate", async (p) => {
    await p.reload({ waitUntil: "networkidle" });
    await sleep(1200);
    await r.cap("customer", "The order shows Delivered. The customer rates the delivery", step());
    await tap(p, p.getByRole("radio", { name: "5 stars" }));
    await type(p, p.getByLabel("Comment"), "Quick and polite delivery, thank you!");
    await tap(p, p.getByRole("button", { name: "Submit rating" }), { after: 2000 });
    await sleep(1500);
  });

  // ---------------------------------------------------------------- admin oversight (web only)
  if (admin) {
    r.card("6. The admin sees everything", "Orders, the delivery trip and ratings in the admin panel");
    await r.scene("admin", "admin", async (p) => {
      await go(p, "/admin/login");
      await r.cap("admin", "The admin signs in to the admin panel", step());
      await type(p, p.getByLabel("Email"), "admin@pixcart.in");
      await type(p, p.getByLabel("Password"), process.env.ADMIN_PW, { delay: 40 });
      await tap(p, p.getByRole("button", { name: "Sign in" }), { after: 1500 });
      await p.waitForURL("**/admin");
      await sleep(2000);
      await r.cap("admin", "Finds the order, its packages, payment, delivery trip and history", step());
      await go(p, "/admin/orders", 1500);
      await tap(p, p.locator("a[href^='/admin/orders/']", { hasText: orderNo }).first(), { after: 2500 });
      await scroll(p, 500, 1500);
      await scroll(p, 600, 1500);
      await go(p, "/admin/delivery/trips?status=delivered", 2500);
      await sleep(1500);
    });
  }
  await r.finish();
  console.log("order", orderNo);
})().catch((e) => { console.error(e); process.exit(1); });
