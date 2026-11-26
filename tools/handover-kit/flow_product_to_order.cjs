/*
 * One real-user flow across roles, in browsers, on the running site:
 *   seller adds a product with a photo and submits it  ->  admin approves it  ->  a new customer finds it in search,
 *   buys it with cash on delivery  ->  the seller sees and confirms the order  ->  the admin sees the order and
 *   exports the orders list (CSV contains the order number)  ->  the seller exports orders too.
 *
 *   node tools/handover-kit/flow_product_to_order.cjs --web http://localhost:5300 --log C:/Users/haris/pixcart-tools/e2e-api-net.log
 * The admin password comes from ADMIN_PASSWORD (default: the browser-test database's admin password).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const PW = process.env.PLAYWRIGHT_DIR || "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/@playwright/test";
const CHROME = process.env.CHROME_PATH || "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe";
const { chromium, expect } = require(PW);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const WEB = arg("web", "http://localhost:5300");
const LOG = arg("log", "C:/Users/haris/pixcart-tools/e2e-api-net.log");
const SELLER_PHONE = arg("seller", "9000000003");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "PixCart@Admin2026";
const stamp = Date.now().toString().slice(-6);
const TITLE = `Steel Water Bottle 1 Litre Flow ${stamp}`;
const steps = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { await fn(); steps.push({ name, ok: true }); console.log(`ok    ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
  catch (e) { steps.push({ name, ok: false, error: e.message.split("\n")[0] }); console.log(`FAIL  ${name}: ${e.message.split("\n").slice(0, 3).join(" | ")}`); throw e; }
};

async function otpFor(phone) {
  for (let i = 0; i < 60; i++) {
    const hits = [...fs.readFileSync(LOG, "utf8").matchAll(new RegExp(`DEV OTP for ${phone}: (\\d+)`, "g"))];
    if (hits.length) return hits[hits.length - 1][1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code for ${phone} in the API log`);
}

async function otpLogin(page, phone, name) {
  const code = page.locator("input[autocomplete=one-time-code]");
  if (name) {
    if (!page.url().includes("/signup")) await page.getByRole("link", { name: /Create (an account|your seller account)/ }).last().click();
    await page.waitForURL(/\/signup/);
    const nameBox = page.locator("input[autocomplete=name]");
    const form = page.locator("form", { has: nameBox });
    await nameBox.fill(name);
    await form.locator("input[type=tel]").fill(phone);
    const terms = page.getByRole("checkbox").first();
    if (!(await terms.isChecked())) await terms.check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(code).toBeVisible({ timeout: 20000 });
    await code.fill(await otpFor(phone));
    await page.getByRole("button", { name: "Verify and create account" }).click();
    return;
  }
  const input = page.locator("form").filter({ has: page.getByRole("button", { name: "Send code" }) }).locator("input[type=tel]").first();
  await input.fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(code).toBeVisible({ timeout: 20000 });
  await code.fill(await otpFor(phone));
  await page.getByRole("button", { name: "Verify and continue" }).click();
}

function photo() {
  // a real 400x400 PNG (solid colour) for the listing photo
  const zlib = require("zlib");
  const w = 400, h = 400, row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = 30; row[2 + x * 3] = 120; row[3 + x * 3] = 160; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require("zlib").crc32 ? require("zlib").crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = () => browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, baseURL: WEB });
  const seller = await (await ctx()).newPage();
  const admin = await (await ctx()).newPage();
  const buyer = await (await ctx()).newPage();
  const pageErrors = [];
  for (const p of [seller, admin, buyer]) p.on("pageerror", (e) => pageErrors.push(e.message));
  let orderNumber = "", productId = "";

  try {
    await step("seller signs in", async () => {
      await seller.goto("/login?next=/seller");
      await otpLogin(seller, SELLER_PHONE);
      await seller.waitForURL((u) => u.pathname === "/seller", { timeout: 30000 });
    });

    await step("seller adds a product with a photo and submits it for review", async () => {
      const cats = await (await seller.request.get("/api/catalog/categories")).json();
      const leaf = cats.flatMap((c) => c.children?.length ? c.children : [c]).find((c) => !(c.required_details || []).length && /kitchen|home|cook|dining|bottle/i.test(c.name))
        || cats.flatMap((c) => c.children?.length ? c.children : [c]).find((c) => !(c.required_details || []).length);
      await seller.goto("/seller/products/new");
      await seller.locator("#cat").selectOption(leaf.id);
      await seller.getByLabel("Product title").fill(TITLE);
      await seller.getByLabel("Brand").fill("FlowCraft");
      await seller.getByLabel("Country of origin").fill("India");
      await seller.getByLabel("Description").fill("Leak proof stainless steel bottle, 1 litre, keeps water cool. Food grade steel, easy to clean.");
      await seller.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "bottle.png", mimeType: "image/png", buffer: photo() });
      await expect(seller.getByRole("button", { name: "Remove photo" }).first()).toBeVisible({ timeout: 30000 });
      await seller.getByLabel("SKU").first().fill(`FLOW-${stamp}`);
      await seller.getByLabel("MRP").first().fill("799");
      await seller.getByLabel("Selling price").first().fill("549");
      await seller.getByLabel("Stock").first().fill("25");
      await seller.getByLabel("Weight in grams").first().fill("400");
      await seller.getByLabel("HSN code").fill("7323");
      const created = seller.waitForResponse((r) => /\/api\/seller\/products(\/[^/]+)?$/.test(r.url()) && ["POST", "PUT", "PATCH"].includes(r.request().method()), { timeout: 30000 });
      await seller.getByRole("button", { name: "Save and submit for review" }).click();
      const res = await created;
      if (res.status() >= 400) throw new Error(`save answered ${res.status()}: ${(await res.text()).slice(0, 300)}`);
      const body = await res.json().catch(() => ({}));
      productId = body.id || body.product?.id || "";
      await expect(seller.getByText(/review|Pending/i).first()).toBeVisible({ timeout: 20000 });
      if (!productId) {
        const list = await (await seller.request.get(`/api/seller/products?q=${encodeURIComponent(TITLE)}&status=pending`)).json().catch(() => ({}));
        productId = list.items?.[0]?.id || "";
      }
    });

    await step("admin signs in", async () => {
      await admin.goto("/admin/login");
      await admin.getByLabel("Email").fill(process.env.ADMIN_EMAIL || "admin@pixcart.in");
      await admin.getByLabel("Password").fill(ADMIN_PASSWORD);
      await admin.getByRole("button", { name: "Sign in" }).click();
      await admin.waitForURL("**/admin");
    });

    await step("admin finds the product in the review queue and approves it", async () => {
      await admin.goto("/admin/products?status=pending");
      await admin.getByPlaceholder("Search titles").fill(`Flow ${stamp}`);
      await admin.getByRole("link", { name: new RegExp(`Flow ${stamp}`) }).first().click();
      await admin.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(admin.getByText(/Live|Approved/).first()).toBeVisible({ timeout: 20000 });
    });

    await step("a new customer finds it in search and adds it to the cart", async () => {
      await buyer.goto("/");
      await buyer.locator("#site-search").fill(`Flow ${stamp}`);
      await buyer.locator("#site-search").press("Enter");
      await expect(buyer.getByText("Results for").first()).toBeVisible();
      await buyer.getByRole("link", { name: new RegExp(`Flow ${stamp}`) }).first().click();
      await expect(buyer.getByRole("heading", { name: TITLE })).toBeVisible({ timeout: 20000 });
      const img = buyer.locator("main img").first();
      await expect(img).toBeVisible();
      if (!(await img.evaluate((i) => i.complete && i.naturalWidth > 0))) throw new Error("product photo did not load");
      await buyer.getByRole("button", { name: "Add to cart" }).first().click();
      await expect(buyer.getByText("Added to your cart").first()).toBeVisible();
    });

    await step("the customer creates an account and places the order with cash on delivery", async () => {
      await buyer.goto("/cart");
      await buyer.getByText("Sign in to place order").click();
      const phone = "98" + String(Math.floor(10000000 + Math.random() * 89999999));
      await otpLogin(buyer, phone, "Flow Buyer");
      await buyer.waitForURL((u) => u.pathname === "/checkout", { timeout: 30000 });
      await buyer.getByLabel("Full name").fill("Flow Buyer");
      await buyer.locator("input[autocomplete=tel-national]").fill(phone);
      await buyer.locator("input[autocomplete=address-line1]").fill("14 Anna Salai, Teynampet");
      await buyer.locator("input[autocomplete=postal-code]").fill("600018");
      await buyer.locator("input[autocomplete=address-level2]").fill("Chennai");
      await buyer.getByRole("button", { name: "Save address" }).click();
      await expect(buyer.getByText("Review items").first()).toBeVisible();
      await buyer.getByText("Cash on delivery", { exact: true }).click();
      await buyer.getByRole("button", { name: "Place order" }).click();
      await expect(buyer.getByText("Package 1 of 1").first()).toBeVisible({ timeout: 30000 });
      orderNumber = ((await buyer.locator("h1").first().textContent()) || "").replace("Order", "").trim();
      if (!/^PC/.test(orderNumber)) throw new Error(`unexpected order number "${orderNumber}"`);
    });

    await step("the seller sees the new order and confirms it", async () => {
      await seller.goto("/seller/orders?status=placed");
      await seller.getByLabel("Search orders").fill(orderNumber);
      await seller.getByRole("link", { name: `${orderNumber}-1` }).click();
      await expect(seller.getByText(TITLE).first()).toBeVisible();
      await seller.getByRole("button", { name: "Confirm order" }).click();
      await expect(seller.getByRole("button", { name: "Mark as packed" })).toBeVisible({ timeout: 20000 });
    });

    await step("the admin sees the order and its CSV export contains it", async () => {
      await admin.goto(`/admin/orders?q=${orderNumber}`);
      await expect(admin.getByText(orderNumber).first()).toBeVisible({ timeout: 20000 });
      await admin.goto("/admin/orders");
      await admin.getByRole("button", { name: "Export" }).click();
      await admin.getByRole("radio", { name: "CSV" }).click();
      const dl = admin.waitForEvent("download", { timeout: 60000 });
      await admin.getByRole("button", { name: "Download CSV" }).click();
      const file = path.join(os.tmpdir(), `orders-${stamp}.csv`);
      await (await dl).saveAs(file);
      const csv = fs.readFileSync(file, "utf8");
      if (!csv.includes(orderNumber)) throw new Error(`CSV (${csv.length} bytes) has no ${orderNumber}`);
    });

    await step("the seller exports orders as Excel", async () => {
      await seller.goto("/seller/orders");
      await seller.getByRole("button", { name: "Export" }).click();
      await seller.getByRole("radio", { name: "Excel" }).click();
      const dl = seller.waitForEvent("download", { timeout: 60000 });
      await seller.getByRole("button", { name: "Download Excel" }).click();
      const file = path.join(os.tmpdir(), `seller-orders-${stamp}.xlsx`);
      await (await dl).saveAs(file);
      const head = fs.readFileSync(file).subarray(0, 2).toString();
      if (head !== "PK") throw new Error("the download is not an Excel file");
    });
  } catch { /* the failing step is already reported */ }

  await browser.close();
  const bad = steps.filter((s) => !s.ok);
  console.log(`\npage errors: ${pageErrors.length}`); for (const e of pageErrors.slice(0, 5)) console.log("   ", e.slice(0, 200));
  console.log(bad.length ? `\nFAILED at: ${bad[0].name}` : `\nALL ${steps.length} STEPS PASSED (product "${TITLE}", order ${orderNumber})`);
  process.exit(bad.length ? 1 : 0);
})();
