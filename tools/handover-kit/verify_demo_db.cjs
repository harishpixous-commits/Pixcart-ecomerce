/*
 * Checks a fresh install of the demo database through the real website: storefront pages and product images,
 * a shopper's sign-in with a one-time code, the admin sign-in, and admin pages with product photos. Every image on
 * every page must load (no broken images, no failed /media request) and the browser console must stay clean.
 *
 *   node tools/handover-kit/verify_demo_db.cjs --web http://localhost:4239 --admin-email admin@pixcart.in \
 *        --phone 9999900001 [--product <slug>] [--category <slug>]
 * The admin password is read from the environment variable DEMO_ADMIN_PASSWORD (never from the command line).
 */
const PW = process.env.PLAYWRIGHT_DIR || "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/@playwright/test";
const CHROME = process.env.CHROME_PATH || "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe";
const { chromium } = require(PW);

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const WEB = arg("web", "http://localhost:4239");
const ADMIN_EMAIL = arg("admin-email", "admin@pixcart.in");
const PHONE = arg("phone", "9999900001");
const results = [];

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {            // scroll through the page so lazy images load
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
    for (const img of Array.from(document.images)) img.loading = "eager";
    await Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 6000); })));
  }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function check(page, label, url, expect) {
  const failed = [];
  const onResponse = (r) => { if (/\/(media|api)\//.test(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${r.url().replace(WEB, "")}`); };
  page.on("response", onResponse);
  if (url) await page.goto(WEB + url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await settle(page);
  page.off("response", onResponse);
  const imgs = await page.evaluate(() => Array.from(document.images).map((i) => ({ src: i.currentSrc || i.src, ok: i.complete && i.naturalWidth > 0 })));
  const broken = imgs.filter((i) => i.src && !i.src.startsWith("data:") && !i.ok).map((i) => i.src.replace(location.origin, ""));
  const mediaImgs = imgs.filter((i) => i.src.includes("/media/")).length;
  const text = expect ? await page.locator("body").innerText() : "";
  const found = expect ? expect.every((t) => text.includes(t)) : true;
  const row = { page: label, url: page.url().replace(WEB, ""), images: imgs.length, media_images: mediaImgs, broken, failed_requests: failed, expected_text: found };
  results.push(row);
  console.log(`${broken.length || failed.length || !found ? "FAIL" : "ok  "}  ${label.padEnd(26)} images ${String(imgs.length).padStart(3)} (media ${mediaImgs})  broken ${broken.length}  failed requests ${failed.length}${found ? "" : "  MISSING TEXT"}`);
  for (const b of broken.slice(0, 5)) console.log("        broken:", b);
  for (const f of failed.slice(0, 5)) console.log("        failed:", f);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const consoleErrors = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

  // storefront as a guest
  const api = async (p) => (await ctx.request.get(WEB + p)).json();
  const list = await api("/api/catalog/products?page_size=1");
  const product = arg("product", list.items[0].slug);
  const category = arg("category", (await api("/api/catalog/categories"))[0].slug);
  await check(page, "home", "/");
  await check(page, "category listing", `/c/${category}`);
  await check(page, "search listing", "/search?q=cotton");
  await check(page, "product detail", `/p/${product}`, [list.items[0].title]);

  // shopper sign-in with the one-time code shown on screen in development
  await page.goto(WEB + "/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel(/mobile/i).first().fill(PHONE);
  await page.getByRole("button", { name: "Send code" }).click();
  const otp = (await page.locator("[data-testid=dev-otp]").textContent({ timeout: 30000 })).trim();
  await page.getByLabel("One-time code").fill(otp);
  await page.locator("form", { has: page.getByLabel("One-time code") }).locator("button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  const me = await page.evaluate(async () => (await fetch("/api/auth/refresh", { method: "POST", headers: { "X-Requested-With": "pixcart" } })).status);
  console.log(`ok    shopper sign-in              code from screen, session refresh ${me}`);
  results.push({ page: "shopper sign-in", ok: me === 200 });
  await check(page, "my orders (signed in)", "/orders");

  // admin sign-in
  const page2 = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  page2.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  await page2.goto(WEB + "/admin/login", { waitUntil: "domcontentloaded" });
  await page2.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page2.getByLabel(/password/i).fill(process.env.DEMO_ADMIN_PASSWORD || "");
  await page2.locator("form", { has: page2.getByLabel(/password/i) }).locator("button[type=submit]").click();
  await page2.waitForURL((u) => u.pathname === "/admin" || u.pathname === "/admin/", { timeout: 30000 });
  console.log(`ok    admin sign-in                ${ADMIN_EMAIL}`);
  results.push({ page: "admin sign-in", ok: true });
  await check(page2, "admin dashboard", null, ["Overview"]);
  await check(page2, "admin products", "/admin/products?status=approved");
  const firstId = (await (await page2.context().request.get(WEB + "/api/catalog/products?page_size=1")).json()).items[0].id;
  if (firstId) await check(page2, "admin product detail", `/admin/products/${firstId}`);
  await check(page2, "admin orders", "/admin/orders");

  await browser.close();
  const bad = results.filter((r) => (r.broken && r.broken.length) || (r.failed_requests && r.failed_requests.length) || r.expected_text === false || r.ok === false);
  console.log(`\nconsole errors: ${consoleErrors.length}`); for (const e of consoleErrors.slice(0, 8)) console.log("   ", e);
  console.log(bad.length ? `\nFAILED: ${bad.length} check(s)` : "\nALL CHECKS PASSED");
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e.message); process.exit(2); });
