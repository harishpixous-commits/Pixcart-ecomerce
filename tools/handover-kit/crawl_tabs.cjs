/*
 * Opens every page of a panel as a signed-in user, clicks every tab on it, and reports any API call that fails
 * (5xx, or 4xx other than the expected 401/403/404/409/422) and any browser error, page by page.
 *
 *   node tools/handover-kit/crawl_tabs.cjs --web http://localhost:5300 --as admin|seller --log <API log with sign-in codes>
 * The admin password comes from ADMIN_PASSWORD.
 */
const fs = require("fs");
const PW = process.env.PLAYWRIGHT_DIR || "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/@playwright/test";
const CHROME = process.env.CHROME_PATH || "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe";
const { chromium } = require(PW);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const WEB = arg("web", "http://localhost:5300");
const AS = arg("as", "admin");
const LOG = arg("log", "C:/Users/haris/pixcart-tools/e2e-api-net.log");

const ADMIN = ["", "go-live", "orders", "returns", "refunds", "support", "customers", "delivery", "delivery/live", "delivery/queue", "delivery/trips",
  "delivery/partners", "delivery/payouts", "delivery/reports", "delivery/feedback", "delivery/zones", "delivery/settings", "sellers", "products", "categories",
  "reviews", "questions", "product-reports", "payouts", "reports", "exports", "storefront", "product-page", "checkout", "coupons", "deals", "advertising",
  "notifications", "shop-assistant", "assistant", "ai", "ai-providers", "settings", "sign-in", "integrations", "staff", "audit", "account", "regional"];
const SELLER = ["", "orders", "returns", "products", "products/new", "products/import", "inventory", "warehouses", "deals", "coupons", "advertising",
  "questions", "reviews", "product-reports", "payouts", "exports", "settings", "analytics", "onboarding", "earnings"];
const EXPECTED = new Set([401, 403, 404, 409, 422]);

async function otpFor(phone) {
  for (let i = 0; i < 60; i++) {
    const hits = [...fs.readFileSync(LOG, "utf8").matchAll(new RegExp(`DEV OTP for ${phone}: (\\d+)`, "g"))];
    if (hits.length) return hits[hits.length - 1][1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no code in the API log");
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, baseURL: WEB })).newPage();
  if (AS === "admin") {
    await page.goto("/admin/login");
    await page.getByLabel("Email").fill(process.env.ADMIN_EMAIL || "admin@pixcart.in");
    await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD || "PixCart@Admin2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/admin");
  } else {
    await page.goto("/login?next=/seller");
    const input = page.locator("form").filter({ has: page.getByRole("button", { name: "Send code" }) }).locator("input[type=tel]").first();
    await input.fill(process.env.SELLER_PHONE || "9000000001");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.locator("input[autocomplete=one-time-code]").fill(await otpFor(process.env.SELLER_PHONE || "9000000001"));
    await page.getByRole("button", { name: "Verify and continue" }).click();
    await page.waitForURL((u) => u.pathname === "/seller");
  }
  const routes = (AS === "admin" ? ADMIN : SELLER).map((r) => `/${AS}${r ? "/" + r : ""}`);
  let failedPages = 0;
  for (const route of routes) {
    const problems = [];
    const onResponse = (r) => { if (r.url().includes("/api/") && r.status() >= 400 && !EXPECTED.has(r.status())) problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(WEB, "")}`); };
    const onError = (e) => problems.push(`page error: ${e.message.slice(0, 160)}`);
    page.on("response", onResponse);
    page.on("pageerror", onError);
    try {
      await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      const tabs = await page.getByRole("tab").count();
      for (let i = 0; i < tabs; i++) {
        await page.getByRole("tab").nth(i).click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
      }
      const notFound = await page.getByText(/page (was )?not found|could not find this page/i).count();
      if (notFound) problems.push("shows a not-found page");
      console.log(`${problems.length ? "FAIL" : "ok  "}  ${route.padEnd(30)} tabs ${tabs}${problems.length ? "  " + problems.slice(0, 4).join(" | ") : ""}`);
      if (problems.length) failedPages++;
    } catch (e) {
      failedPages++;
      console.log(`FAIL  ${route.padEnd(30)} ${e.message.split("\n")[0]}`);
    }
    page.off("response", onResponse);
    page.off("pageerror", onError);
  }
  await browser.close();
  console.log(failedPages ? `\n${failedPages} page(s) with problems` : `\nALL ${routes.length} PAGES CLEAN`);
  process.exit(failedPages ? 1 : 0);
})();
