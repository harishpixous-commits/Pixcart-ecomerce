/*
 * Phone-size audit: every screen at 390 x 844 for each person. Reports sideways overflow (what is wider than the screen),
 * page errors and console errors, and saves a screenshot per screen.  node audit.cjs <outDir> [base]
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));

const OUT = process.argv[2];
const B = process.argv[3] || "http://localhost:3100";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = {
  guest: ["/", "/categories", "/c/mobiles-electronics", "/search?q=shirt", "/p/portable-bluetooth-speaker-20w-waterproof", "/deals", "/bestsellers",
    "/new-releases", "/coupons", "/compare", "/help", "/help/returns", "/help/grievance", "/contact", "/pages/terms", "/sell", "/app", "/login", "/signup",
    "/this-page-does-not-exist", "/delivery/join", "/delivery/download", "/delivery/login"],
  customer: ["/orders", "/cart", "/checkout", "/account", "/wishlist", "/alerts", "/notifications", "/support", "/support/new"],
  seller: ["/seller", "/seller/orders", "/seller/returns", "/seller/products", "/seller/products/new", "/seller/products/import", "/seller/inventory",
    "/seller/warehouses", "/seller/deals", "/seller/advertising", "/seller/coupons", "/seller/questions", "/seller/reviews", "/seller/product-reports",
    "/seller/payouts", "/seller/analytics", "/seller/exports", "/seller/settings", "/seller/onboarding"],
  partner: ["/delivery", "/delivery/history", "/delivery/earnings", "/delivery/profile", "/delivery/notifications", "/delivery/help"],
  admin: ["/admin", "/admin/go-live", "/admin/orders", "/admin/returns", "/admin/refunds", "/admin/support", "/admin/customers", "/admin/delivery",
    "/admin/delivery/live", "/admin/delivery/queue", "/admin/delivery/trips", "/admin/delivery/partners", "/admin/delivery/payouts", "/admin/delivery/reports",
    "/admin/delivery/feedback", "/admin/delivery/zones", "/admin/delivery/settings", "/admin/sellers", "/admin/products", "/admin/categories", "/admin/reviews",
    "/admin/questions", "/admin/product-reports", "/admin/payouts", "/admin/reports", "/admin/exports", "/admin/storefront", "/admin/product-page",
    "/admin/checkout", "/admin/coupons", "/admin/deals", "/admin/advertising", "/admin/notifications", "/admin/shop-assistant", "/admin/assistant",
    "/admin/ai", "/admin/ai-providers", "/admin/settings", "/admin/sign-in", "/admin/integrations", "/admin/staff", "/admin/audit", "/admin/account"],
};

async function otp(page, loginPath, phone, done) {
  await page.goto(B + loginPath, { waitUntil: "networkidle" });
  const got = page.waitForResponse((r) => r.url().includes("/api/auth/otp/request"));
  await page.locator("input[type=tel]").first().fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  const code = (await (await got).json()).dev_otp;
  await page.locator("input[autocomplete=one-time-code]").fill(code);
  await page.getByRole("button", { name: /Verify/ }).click();
  await page.waitForURL(done, { timeout: 60000 });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const report = [];
  for (const who of Object.keys(ROUTES)) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      ...(who === "partner" ? { geolocation: { latitude: 12.93, longitude: 77.62 }, permissions: ["geolocation"] } : {}) });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45000);
    let errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|ERR_ABORTED/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
    try {
      if (who === "customer") await otp(page, "/login?next=/orders", "9999900001", (u) => u.pathname === "/orders");
      if (who === "seller") await otp(page, "/login?next=/seller", "9000000001", (u) => u.pathname === "/seller");
      if (who === "partner") await otp(page, "/delivery/login", "7300000001", (u) => u.pathname.startsWith("/delivery") && !u.pathname.includes("login"));
      if (who === "admin") {
        await page.goto(B + "/admin/login", { waitUntil: "networkidle" });
        await page.getByLabel("Email").fill("admin@pixcart.in");
        await page.getByLabel("Password").fill(process.env.ADMIN_PW);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL("**/admin");
      }
    } catch (e) { report.push({ who, route: "(sign-in)", error: e.message.slice(0, 200) }); }
    for (const route of ROUTES[who]) {
      errs = [];
      await page.goto(B + route, { waitUntil: "networkidle", timeout: 90000 }).catch((e) => errs.push("goto: " + e.message.slice(0, 100)));
      await sleep(1200);
      const o = await page.evaluate(() => {
        const W = window.innerWidth;
        const over = document.documentElement.scrollWidth - W;
        const wide = [];
        if (over > 1) {
          for (const el of document.querySelectorAll("body *")) {
            const r = el.getBoundingClientRect();
            if (r.right > W + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
              let p = el.parentElement, clipped = false;
              while (p) { const ov = getComputedStyle(p).overflowX; if (ov === "auto" || ov === "scroll" || ov === "hidden") { clipped = true; break; } p = p.parentElement; }
              if (!clipped) wide.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ").slice(0, 3).join(".")} (${Math.round(r.right)}px)`);
            }
          }
        }
        return { over, wide: wide.slice(0, 4) };
      }).catch(() => ({ over: 0, wide: [] }));
      const name = `${who}${route.replace(/[^a-z0-9]+/gi, "-")}`.slice(0, 80);
      await page.screenshot({ path: path.join(OUT, name + ".png") }).catch(() => {});
      report.push({ who, route, over: o.over, wide: o.wide, errors: errs.slice(0, 3), shot: name });
      if (o.over > 1 || errs.length) console.log("ISSUE", who, route, o.over > 1 ? `overflow ${o.over}px ${o.wide.join(" | ")}` : "", errs.join(" || "));
    }
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  console.log("screens", report.length, "with issues", report.filter((r) => r.over > 1 || (r.errors || []).length || r.error).length);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
