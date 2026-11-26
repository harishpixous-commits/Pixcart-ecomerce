/*
 * Video: the delivery partner app on a phone, start to finish. The app's home page, register (about, vehicle,
 * documents, payouts, review and submit), approval, going online, a real request (a customer order made ready by the
 * seller in the background), pickup with the seller's code, delivery with the customer's code, cash and a photo,
 * then history, earnings, profile, notifications and help.
 *   node delivery.cjs <recDir>
 */
const path = require("path");
const fs = require("fs");
const { Recorder, tap, type, scroll, top, go, otpSignIn, apiAs, sleep } = require("./rec.cjs");

const PHONE = process.env.NEW_PARTNER || "7300000002";
const STORE = { latitude: 12.9301, longitude: 77.6232 };
const IMG = (f) => path.join(process.env.DEMO_IMAGES, f);
const SELFIE = IMG("p08-1.jpg");
const DOC = IMG("p25-1.jpg");
const PROOF = path.join(process.env.MEDIA_DIR, "products", fs.readdirSync(path.join(process.env.MEDIA_DIR, "products")).find((f) => f.endsWith(".webp")));
let n = 0;
const step = () => `Step ${++n}`;

async function saveAndContinue(p) {
  await tap(p, p.getByRole("button", { name: /Save and continue/ }), { after: 2000 });
}

/** A customer order in the zone, confirmed and made ready for pickup by the seller, through the API. */
async function readyOrder() {
  const c = await apiAs("9876500022", "Ananya Rao");
  const prod = await c.get("/api/catalog/products/portable-bluetooth-speaker-20w-waterproof");
  await c.post("/api/cart/items", { variant_id: prod.variants[0].id, qty: 1 });
  const a = await (await c.post("/api/addresses", { full_name: "Ananya Rao", phone: "9876500022", line1: "22, 5th Cross, 4th Block, Koramangala",
    city: "Bengaluru", state_code: "29", pincode: "560034", is_default: true })).json();
  const o = (await (await c.post("/api/orders", { address_id: a.id, payment_method: "cod", idempotency_key: `partner-video-${Date.now()}` })).json()).order;
  const s = await apiAs("9000000002", "Seller");
  const sub = (await s.get("/api/seller/orders?status=placed")).items.find((x) => x.order_number === o.number || (x.number || "").startsWith(o.number)) ||
    (await s.get("/api/seller/orders?status=placed")).items[0];
  await s.post(`/api/seller/orders/${sub.id}/confirm`);
  const ready = await (await s.post(`/api/seller/orders/${sub.id}/ready-for-pickup`)).json();
  const detail = await s.get(`/api/seller/orders/${sub.id}`);
  const pickup = JSON.stringify(detail).match(/"pickup_code"\s*:\s*"(\d{4})"/)?.[1] || JSON.stringify(ready).match(/"pickup_code"\s*:\s*"(\d{4})"/)?.[1];
  return { c, s, order: o, subId: sub.id, pickup };
}

(async () => {
  // only the new partner should get the request: the setup partner goes offline
  const arun = await apiAs("7300000001", "Arun Kumar");
  await arun.post("/api/delivery/me/online", { online: false });
  await arun.dispose();

  const r = new Recorder("delivery", process.argv[2]);
  await r.start();
  await r.page("partner", "partner", { mobile: true, geolocation: STORE });

  r.card("The delivery partner app", "From the app's home page to the first delivery");
  await r.scene("partner", "home", async (p) => {
    await go(p, "/delivery/join", 1500);
    await r.cap("partner", "The partner app's home page: how it works and what partners earn", step());
    await sleep(2200);
    await scroll(p, 700, 1500);
    await scroll(p, 800, 1500);
    await top(p);
  });
  await r.scene("partner", "download", async (p) => {
    await go(p, "/delivery/download", 1500);
    await r.cap("partner", "The app installs on any Android phone", step());
    await sleep(2500);
  });

  r.card("Register", "Mobile sign-in, then 5 short steps");
  await r.scene("partner", "signup", async (p) => {
    await go(p, "/delivery/join", 1200);
    await r.cap("partner", "Taps Register now and signs in with a mobile number", step());
    await tap(p, p.getByRole("link", { name: /Register now/ }).first(), { after: 1500 });
    if (!/\/delivery\/(login|register)/.test(p.url())) await go(p, "/delivery/login");
    if (await p.locator("input[type=tel]").count()) await otpSignIn(p, PHONE);
    await p.getByTestId("register-start").waitFor({ timeout: 60000 });
    await sleep(1200);
  });
  await r.scene("partner", "start", async (p) => {
    await r.cap("partner", "Enters the name and the city to deliver in", step());
    await type(p, p.getByLabel("Your full name (as on your ID)"), "Karthik Raja");
    const city = p.locator("[data-testid=register-start] select");
    if (await city.count()) { await tap(p, city); await city.selectOption({ label: "Bengaluru" }).catch(() => city.selectOption({ index: 0 })); }
    await tap(p, p.getByRole("button", { name: /Start registration/ }), { after: 2500 });
  });
  await r.scene("partner", "about", async (p) => {
    await r.cap("partner", "Step 1 – About you: a selfie, the area and home address", step());
    await p.getByLabel(/Your photo/).setInputFiles(SELFIE);
    await sleep(2500);
    const area = p.locator("select").first();
    if (await area.count()) { await area.selectOption({ index: 1 }).catch(() => {}); await sleep(600); }
    await type(p, p.getByLabel("Home address"), "18 Hosur Road, Koramangala, Bengaluru", { delay: 35 });
    await saveAndContinue(p);
  });
  await r.scene("partner", "vehicle", async (p) => {
    await r.cap("partner", "Step 2 – Vehicle: type and number plate", step());
    await tap(p, p.getByRole("radio", { name: /Scooter|Motorcycle|Bike/i }).first());
    await type(p, p.getByLabel("Vehicle number"), "KA 05 MJ 4421");
    await saveAndContinue(p);
  });
  await r.scene("partner", "documents", async (p) => {
    await r.cap("partner", "Step 3 – Documents: driving licence and ID proof (only the last 4 digits are ever shown)", step());
    await type(p, p.getByLabel("Licence number"), "KA05 20210067890");
    await p.getByLabel(/Licence photo/).setInputFiles(DOC);
    await sleep(2200);
    const idNo = p.getByLabel(/number$/).last();
    await type(p, idNo, "345678901234");
    await p.locator("input[type=file]").last().setInputFiles(DOC);
    await sleep(2200);
    await saveAndContinue(p);
  });
  await r.scene("partner", "payouts", async (p) => {
    await r.cap("partner", "Step 4 – Payouts: the bank account for weekly earnings", step());
    await type(p, p.getByLabel("Account holder name"), "Karthik Raja");
    await type(p, p.getByLabel("Account number", { exact: true }), "50100123456789");
    await type(p, p.getByLabel("Re-enter account number"), "50100123456789");
    await type(p, p.getByLabel("IFSC"), "HDFC0001234");
    await saveAndContinue(p);
  });
  await r.scene("partner", "submit", async (p) => {
    await r.cap("partner", "Step 5 – Review: checks everything and sends it for approval", step());
    await scroll(p, 500, 1200);
    await tap(p, p.locator("input[type=checkbox]").last());
    await tap(p, p.getByTestId("register-submit"), { after: 2500 });
    await p.getByTestId("under-review").waitFor({ timeout: 30000 }).catch(() => {});
    await r.cap("partner", "Sent. The delivery team checks the documents", `Step ${n}`);
    await sleep(3000);
  });

  // the team approves the partner (Admin -> Delivery partners)
  r.card("Approved", "The delivery team checks the documents and approves the partner in the admin panel", 4);
  {
    const admin = await apiAs("admin");
    const zone = (await admin.get("/api/admin/delivery/zones")).find((z) => z.pincodes.includes("560034"));
    const list = await admin.get("/api/admin/delivery/partners?q=Karthik");
    const partner = (list.items || list).find((x) => (x.name || "").startsWith("Karthik") && (x.kyc_status || x.status) === "submitted")
      || (list.items || list).find((x) => (x.name || "").startsWith("Karthik"));
    const ok = await admin.post(`/api/admin/delivery/partners/${partner.id}/kyc`, { action: "approve", zone_id: zone.id });
    console.log("approved", ok.status());
    await admin.dispose();
  }

  await r.scene("partner", "online", async (p) => {
    await go(p, "/delivery", 2000);
    await r.cap("partner", "Approved! The partner goes online and shares location", step());
    await p.getByTestId("partner-home").waitFor({ timeout: 60000 });
    const sw = p.locator("[data-testid=partner-home] [data-testid=online-switch]");
    if ((await sw.getAttribute("aria-checked")) !== "true") await tap(p, sw, { after: 1500 });
    await p.getByText("Location is on").waitFor({ timeout: 30000 });
    await r.cap("partner", "Online and waiting for delivery requests nearby", `Step ${n}`);
    await sleep(2500);
  });

  // meanwhile a customer orders and the seller taps Ready for pickup
  const job = await readyOrder();
  const partnerPage = r.pages.partner.page;
  await partnerPage.getByTestId("offer-popup").waitFor({ timeout: 90000 });
  r.card("A delivery request", "A customer ordered; the seller packed it and asked for pickup");
  await r.scene("partner", "offer", async (p) => {
    await r.cap("partner", "A request pops up: pickup store, drop area and the earning", step());
    await sleep(3000);
    await tap(p, p.getByTestId("offer-accept"), { after: 1500 });
    await p.getByTestId("trip-page").waitFor({ timeout: 90000 });
    await r.cap("partner", "The trip opens with the route and each step", `Step ${n}`);
    await sleep(2500);
    await scroll(p, 500, 1500);
    await top(p);
  });
  await r.scene("partner", "pickup", async (p) => {
    await r.cap("partner", `At the store: enters the seller's pickup code (${job.pickup}) and takes the parcel`, step());
    await tap(p, p.getByTestId("step-at-store"), { after: 1200 });
    await type(p, p.getByTestId("pickup-code"), job.pickup, { delay: 160 });
    await tap(p, p.getByTestId("step-picked"), { after: 1500 });
    await r.cap("partner", "Starts the ride to the customer", `Step ${n}`);
    await tap(p, p.getByTestId("step-on-the-way"), { after: 2500 });
  });
  const mine = await job.c.get(`/api/orders/${job.order.id}`);
  const otp = JSON.stringify(mine).match(/"delivery_otp"\s*:\s*"(\d{4})"/)?.[1] || JSON.stringify(mine).match(/"otp"\s*:\s*"(\d{4})"/)?.[1];
  await r.scene("partner", "deliver", async (p) => {
    await r.cap("partner", `At the door: enters the customer's 4-digit code (${otp})`, step());
    await tap(p, p.getByTestId("step-reached"), { after: 1200 });
    await type(p, p.getByTestId("delivery-otp"), otp, { delay: 160 });
    await r.cap("partner", "Collects the cash on delivery and takes a photo at the door", step());
    const due = (await p.getByTestId("cod-amount").getAttribute("placeholder")) || "";
    await tap(p, p.getByTestId("cod-cash"));
    await type(p, p.getByTestId("cod-amount"), due.replace(/[^\d.]/g, ""), { delay: 90 });
    await p.getByTestId("proof-photo").setInputFiles(PROOF);
    await sleep(1500);
    await tap(p, p.getByTestId("mark-delivered"), { after: 1500 });
    await p.getByTestId("trip-done").waitFor({ timeout: 30000 });
    await r.cap("partner", "Delivered! The earning is added straight away", `Step ${n}`);
    await sleep(3000);
  });

  r.card("Earnings and more", "History, earnings, profile, notifications and help");
  for (const [url, text] of [
    ["/delivery/history", "History: every trip with what it earned"],
    ["/delivery/earnings", "Earnings: today, this week, tips, cash in hand and weekly payouts"],
    ["/delivery/profile", "Profile: documents, vehicle, bank details and rating"],
    ["/delivery/notifications", "Notifications: requests, payouts and messages from the team"],
    ["/delivery/help", "Help: answers to common questions and how to reach the team"],
  ]) {
    await r.scene("partner", url, async (p) => {
      await go(p, url, 1500);
      await r.cap("partner", text, step());
      await sleep(2200);
      await scroll(p, 600, 1500);
    });
  }
  await r.scene("partner", "offline", async (p) => {
    await go(p, "/delivery", 1500);
    await r.cap("partner", "Done for the day: goes offline", step());
    const sw = p.locator("[data-testid=partner-home] [data-testid=online-switch]");
    if ((await sw.getAttribute("aria-checked")) === "true") await tap(p, sw, { after: 2000 });
    await sleep(1500);
  });
  await job.c.dispose(); await job.s.dispose();
  await r.finish();
})().catch((e) => { console.error(e); process.exit(1); });
