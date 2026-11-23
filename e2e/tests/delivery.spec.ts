import { deflateSync } from "node:zlib";
import { expect, type APIRequestContext } from "@playwright/test";
import { adminLogin, collectErrors, otpFor, otpLogin, randomPhone, test } from "./helpers";

/*
 * Own delivery fleet, end to end in real browsers: a delivery zone and an approved partner (set up through the API),
 * the partner goes online in the partner app, a customer orders with cash on delivery, the seller taps "Ready for
 * pickup", auto-assign pops the request up on the partner's phone, and the trip runs to the doorstep: pickup code,
 * on the way, the customer's OTP, the cash and a photo, delivered, rated. The admin's live map shows it all.
 */

const PRODUCT = "/p/portable-bluetooth-speaker-20w-waterproof"; // Bengaluru Gadget Hub, warehouse PIN 560095
const STORE = { latitude: 12.9301, longitude: 77.6232 };
const HEADERS = { "X-Requested-With": "pixcart" };

/** A small solid PNG (the API wants photos of at least 200 x 200 pixels). */
function png(size = 240): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x55)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function phoneToken(request: APIRequestContext, phone: string, name: string): Promise<string> {
  expect((await request.post("/api/auth/otp/request", { headers: HEADERS, data: { phone } })).ok()).toBeTruthy();
  const r = await request.post("/api/auth/otp/verify", { headers: HEADERS, data: { phone, code: await otpFor(phone), name } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).access_token;
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const r = await request.post("/api/auth/login", {
    headers: HEADERS, data: { email: process.env.ADMIN_EMAIL ?? "admin@pixcart.in", password: process.env.ADMIN_PASSWORD ?? "PixCart@Admin2026" },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).access_token;
}

const auth = (token: string) => ({ ...HEADERS, Authorization: `Bearer ${token}` });

/** A delivery zone covering the demo seller's warehouse and the customer, and a partner approved in it. */
async function setUpFleet(request: APIRequestContext, partnerPhone: string) {
  const admin = await adminToken(request);
  const zones: { id: string; pincodes: string[] }[] = await (await request.get("/api/admin/delivery/zones", { headers: auth(admin) })).json();
  let zone = zones.find((z) => z.pincodes.includes("560095") && z.pincodes.includes("560034"));
  if (!zone) {
    const r = await request.post("/api/admin/delivery/zones", {
      headers: auth(admin), data: { name: "Koramangala", city: "Bengaluru", pincodes: ["560095", "560034", "560047"], center_lat: 12.9352, center_lng: 77.6245 },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    zone = await r.json();
  }
  const s = await request.put("/api/admin/delivery/settings", { headers: auth(admin), data: { enabled: true, fleet_mode: "zones", auto_assign: true } });
  expect(s.ok(), await s.text()).toBeTruthy();

  const rider = await phoneToken(request, partnerPhone, "Arun Kumar");
  const reg = await request.post("/api/delivery/register", {
    headers: auth(rider),
    data: { name: "Arun Kumar", city: "Bengaluru", address: "4 Hosur Road, Koramangala", vehicle_type: "scooter", vehicle_no: "KA 01 AB 1234",
      license_no: "KA01 20190012345", id_proof_type: "aadhaar", id_proof_no: "234567890123", zone_id: zone!.id },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  for (const [kind, file] of [["photo", { name: "me.png", mimeType: "image/png", buffer: png() }], ["license", { name: "dl.pdf", mimeType: "application/pdf", buffer: PDF }],
    ["id_proof", { name: "id.pdf", mimeType: "application/pdf", buffer: PDF }]] as const) {
    const up = await request.post(`/api/delivery/me/docs/${kind}`, { headers: auth(rider), multipart: { file } });
    expect(up.ok(), await up.text()).toBeTruthy();
  }
  const bank = { holder: "Arun Kumar", account_number: "123456789012", confirm_account_number: "123456789012", ifsc: "SBIN0001234" };
  expect((await request.put("/api/delivery/me/bank", { headers: auth(rider), data: bank })).ok()).toBeTruthy();
  expect((await request.post("/api/delivery/me/submit", { headers: auth(rider) })).ok()).toBeTruthy();
  const me = await (await request.get("/api/delivery/me", { headers: auth(rider) })).json();
  const ok = await request.post(`/api/admin/delivery/partners/${me.id}/kyc`, { headers: auth(admin), data: { action: "approve", zone_id: zone!.id } });
  expect(ok.ok(), await ok.text()).toBeTruthy();
}

test("own delivery partner: request pops up, pickup code, OTP, cash, photo, delivered, rated, return collected", async ({ browser, request }) => {
  test.setTimeout(900_000); // four sign-ins, a delivery and a return pickup
  const partnerPhone = randomPhone("73");
  const customerPhone = randomPhone("95");
  await test.step("a zone and an approved partner", () => setUpFleet(request, partnerPhone));

  // the partner's phone: goes online and shares location near the store
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: STORE, permissions: ["geolocation"] });
  const partner = await pctx.newPage();
  const partnerErrors = collectErrors(partner);
  await test.step("partner goes online", async () => {
    await partner.goto("/delivery/login");
    await otpLogin(partner, partnerPhone);
    await expect(partner.getByTestId("partner-home")).toBeVisible({ timeout: 60_000 });
    const sw = partner.locator("[data-testid=partner-home] [data-testid=online-switch]");
    if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
    await expect(partner.getByText("Location is on")).toBeVisible({ timeout: 30_000 });
    await expect(partner.getByTestId("waiting")).toBeVisible();
  });

  // the customer orders with cash on delivery to a PIN inside the zone
  const customer = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  let orderUrl = "";
  let orderNo = "";
  await test.step("customer orders with cash on delivery", async () => {
    await customer.goto(PRODUCT);
    await customer.getByRole("button", { name: "Add to cart" }).first().click();
    await expect(customer.getByText("Added to your cart").first()).toBeVisible();
    await customer.goto("/cart");
    await customer.getByText("Sign in to place order").click();
    await customer.waitForURL(/\/login/);
    await otpLogin(customer, customerPhone, "Ananya Rao");
    await customer.waitForURL(/\/checkout/, { timeout: 60_000 });
    await customer.getByLabel("Full name").fill("Ananya Rao");
    await customer.locator("input[autocomplete=tel-national]").fill(customerPhone);
    await customer.locator("input[autocomplete=address-line1]").fill("22, 5th Cross, 4th Block, Koramangala");
    await customer.locator("input[autocomplete=postal-code]").fill("560034");
    await expect(customer.locator("#addr-state")).toHaveValue("29"); // Karnataka, from the PIN code
    await customer.locator("input[autocomplete=address-level2]").fill("Bengaluru");
    await customer.getByRole("button", { name: "Save address" }).click();
    await expect(customer.getByText("Review items").first()).toBeVisible({ timeout: 30_000 });
    await customer.getByText("Cash on delivery", { exact: true }).first().click();
    await customer.getByRole("button", { name: "Place order" }).click();
    await expect(customer.getByText("Package 1 of 1").first()).toBeVisible({ timeout: 60_000 });
    orderUrl = customer.url();
    orderNo = ((await customer.locator("h1").first().textContent()) ?? "").replace("Order", "").trim();
  });

  // the seller (Bengaluru Gadget Hub) confirms and hands the package to our partner
  let pickupCode = "";
  const seller = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await test.step("seller marks it ready for pickup", async () => {
    await seller.goto("/login?next=/seller");
    await otpLogin(seller, process.env.FLEET_SELLER_PHONE ?? "9000000002");
    await seller.waitForURL((u) => u.pathname === "/seller");
    await seller.goto("/seller/orders");
    await seller.locator("a[href^='/seller/orders/']", { hasText: orderNo }).first().click();
    await seller.getByRole("button", { name: "Confirm order" }).click();
    await seller.getByTestId("ready-for-pickup").click();
    await expect(seller.getByTestId("fleet-card")).toBeVisible();
    pickupCode = ((await seller.getByTestId("pickup-code-seller").textContent()) ?? "").trim();
    expect(pickupCode).toMatch(/^\d{4}$/);
  });

  await test.step("the request pops up and the partner accepts", async () => {
    await expect(partner.getByTestId("offer-popup")).toBeVisible({ timeout: 30_000 });
    await expect(partner.getByTestId("offer-popup")).toContainText("Collect");
    await partner.getByTestId("offer-accept").click();
    await expect(partner.getByTestId("trip-page")).toBeVisible({ timeout: 90_000 }); // a dev server compiles the page on first use
  });

  await test.step("admin sees the partner on a trip on the live map", async () => {
    const admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await adminLogin(admin);
    await admin.goto("/admin/delivery/live");
    await expect(admin.getByTestId("delivery-live")).toBeVisible({ timeout: 60_000 });
    await expect(admin.getByTestId("live-partner").filter({ hasText: "Arun Kumar" })).toContainText("On a trip");
    await admin.context().close();
  });

  await test.step("pickup with the seller's code, then on the way", async () => {
    await partner.getByTestId("step-at-store").click();
    await partner.getByTestId("pickup-code").fill(pickupCode);
    await partner.getByTestId("step-picked").click();
    await partner.getByTestId("step-on-the-way").click();
    await expect(partner.getByTestId("step-reached")).toBeVisible();
  });

  let otp = "";
  await test.step("customer sees the partner and the OTP", async () => {
    await customer.goto(orderUrl);
    await expect(customer.getByTestId("delivery-tracking")).toContainText("Arun Kumar");
    otp = ((await customer.locator("[data-testid=delivery-otp-customer] .font-mono").textContent()) ?? "").trim();
    expect(otp).toMatch(/^\d{4}$/);
  });

  await test.step("handover: OTP, cash and a photo", async () => {
    await partner.getByTestId("step-reached").click();
    await partner.getByTestId("delivery-otp").fill(otp);
    const due = (await partner.getByTestId("cod-amount").getAttribute("placeholder")) ?? "";
    await partner.getByTestId("cod-cash").click();
    await partner.getByTestId("cod-amount").fill(due);
    await partner.getByTestId("proof-photo").setInputFiles({ name: "door.png", mimeType: "image/png", buffer: png() });
    await partner.getByTestId("mark-delivered").click();
    await expect(partner.getByTestId("trip-done")).toBeVisible({ timeout: 30_000 });
  });

  await test.step("customer rates the delivery", async () => {
    await customer.reload();
    await customer.getByRole("radio", { name: "5 stars" }).click();
    await customer.getByLabel("Comment").fill("Quick and polite");
    await customer.getByRole("button", { name: "Submit rating" }).click();
    await expect(customer.getByText("You rated this delivery")).toBeVisible();
  });

  await test.step("customer returns it; the seller approves; our partner is asked to collect it", async () => {
    await customer.getByRole("button", { name: "Return items" }).click();
    const form = customer.getByRole("dialog");
    await form.getByRole("combobox", { name: /Quantity to return/ }).first().selectOption("1");
    await form.locator("#rr").selectOption({ index: 1 });
    await form.getByLabel("UPI ID for your refund").fill("ananya@okaxis");
    await form.getByRole("button", { name: "Request return" }).click();
    await expect(form).toBeHidden();
    await seller.goto("/seller/returns");
    const card = seller.locator("section", { hasText: orderNo }).first();
    await card.getByRole("button", { name: "Approve return" }).click();
    await expect(partner.getByTestId("offer-popup")).toContainText("Return pickup request", { timeout: 30_000 });
    await partner.getByTestId("offer-accept").click();
    await expect(partner.getByTestId("step-at-customer")).toBeVisible({ timeout: 90_000 });
  });

  await test.step("collect with the customer's code, hand over with the seller's code, seller receives it", async () => {
    await customer.reload();
    const returnCode = ((await customer.getByTestId("return-pickup-code").textContent()) ?? "").trim();
    expect(returnCode).toMatch(/^\d{4}$/);
    await partner.getByTestId("step-at-customer").click();
    await partner.getByTestId("customer-pickup-code").fill(returnCode);
    await partner.getByTestId("step-collected").click();
    await partner.getByTestId("step-to-store").click();
    await partner.getByTestId("return-code").fill(pickupCode); // the seller's code, as at the first pickup
    await partner.getByTestId("handed-to-store").click();
    await expect(partner.getByTestId("trip-done")).toContainText("Returned to the store");
    await seller.reload();
    await seller.getByRole("tab", { name: /In transit/ }).click();
    const card = seller.locator("section", { hasText: orderNo }).first();
    await expect(card.getByTestId("seller-return-pickup")).toBeVisible();
    await card.getByRole("button", { name: "Mark received and refund" }).click();
    // the seller records the item's condition (the suggested choice) before confirming
    const receive = seller.getByRole("dialog");
    await receive.getByRole("button", { name: "Mark received and refund" }).click();
    await expect(seller.locator("section", { hasText: orderNo })).toHaveCount(0); // moved to Received
  });

  expect(partnerErrors).toEqual([]);
  await pctx.close();
  await customer.context().close();
  await seller.context().close();
});

