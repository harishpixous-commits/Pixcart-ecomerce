#!/usr/bin/env node
/*
 * Pixel parity: screenshots the same route on the reference site (Next.js, default http://localhost:3100) and on the
 * Angular app (default http://localhost:4201) and reports the share of pixels that differ.
 *
 *   node tools/parity/compare.cjs [--routes /,/login] [--themes classic,bazaar,fresh,luxe] [--viewports 390x844,1366x900]
 *        [--as guest|admin|seller|partner] [--full] [--ref http://localhost:3100] [--ng http://localhost:4201] [--out dir]
 *
 * Both sites use the same API, so they show the same data. Themes are switched with /theme-preview?theme=<id> (a
 * per-browser preview cookie on both sites). Motion is reduced (no carousel autoplay, no animations) and the page waits
 * for the network and fonts. Results: <out>/<as>-<theme>-<viewport>-<route>.{ref,ng,diff}.png and a summary table;
 * exit code 1 when a screen differs by more than --max (default 1%).
 *
 * Needs: npm install in tools/parity (pixelmatch, pngjs); Playwright from the reference repo's e2e folder.
 */

/** The local demo admin's password: never in the code. Set PARITY_ADMIN_PASSWORD before using --as admin. */
const ADMIN_PASSWORD = () => {
  const v = process.env.PARITY_ADMIN_PASSWORD;
  if (!v) throw new Error("set PARITY_ADMIN_PASSWORD (the local demo admin's password) to compare admin screens");
  return v;
};

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default ?? require("pixelmatch");

const PW = process.env.PLAYWRIGHT_DIR || "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/@playwright/test";
const CHROME = process.env.CHROME_PATH || "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe";
const { chromium } = require(PW);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const REF = arg("ref", "http://localhost:3100");
const NG = arg("ng", "http://localhost:4201");
const API = arg("api", "http://localhost:8100");
const ROUTES = String(arg("routes", "/")).split(",");
const THEMES = String(arg("themes", "classic")).split(",");
const VIEWPORTS = String(arg("viewports", "390x844,1366x900")).split(",").map((v) => v.split("x").map(Number));
const AS = String(arg("as", "guest"));
const FULL = Boolean(arg("full", false));
const MAX = Number(arg("max", 1));
/** CSS selectors hidden on both sites (e.g. page content under a shell that is compared on its own) */
const HIDE = arg("hide", "");
/** admin only: the admin layout to compare (saved as the admin's preference through the API, then put back) */
const ADMIN_LAYOUT = arg("admin-layout", "");
const OUT = path.resolve(String(arg("out", path.join(__dirname, "out"))));
fs.mkdirSync(OUT, { recursive: true });

const ACCOUNTS = { seller: "9000000001", partner: "7300000001", customer: "9999900001" };

/** Signs the browser context in through the site's own API proxy (the refresh cookie lands on that site). */
async function signIn(ctx, base) {
  if (AS === "guest") return;
  const headers = { "X-Requested-With": "pixcart" };
  if (AS === "admin") {
    const r = await ctx.request.post(`${base}/api/auth/login`, { headers, data: { email: "admin@pixcart.in", password: ADMIN_PASSWORD(), totp: "" } });
    if (!r.ok()) throw new Error(`admin login failed on ${base}: ${r.status()}`);
    if (ADMIN_LAYOUT) {
      const token = (await r.json()).access_token;
      await ctx.request.put(`${base}/api/admin/me/preferences`, { headers: { ...headers, Authorization: `Bearer ${token}` }, data: { admin_layout: ADMIN_LAYOUT === "default" ? null : ADMIN_LAYOUT } });
    }
  } else {
    const phone = ACCOUNTS[AS];
    const purpose = AS === "partner" ? "any" : "signin";
    let sent = {};
    for (let i = 0; i < 4 && !sent.dev_otp; i++) {
      if (i) await new Promise((r) => setTimeout(r, 16000)); // the resend wait
      sent = await (await ctx.request.post(`${base}/api/auth/otp/request`, { headers, data: { phone, purpose } })).json();
    }
    const r = await ctx.request.post(`${base}/api/auth/otp/verify`, { headers, data: { phone, code: sent.dev_otp, purpose, accept_terms: true } });
    if (!r.ok()) throw new Error(`${AS} login failed on ${base}: ${r.status()}`);
  }
  await ctx.addInitScript(() => { try { localStorage.setItem("pc_signed_in", "1"); } catch { /* */ } });
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // let skeleton hand-overs, sticky headers and lazy images finish
  await page.evaluate(async () => {
    for (const img of Array.from(document.images)) img.loading = "eager";
    await Promise.all(Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  }).catch(() => {});
  await page.waitForTimeout(900);
}

/** One signed-in browser context per site for the whole run (sign-in limits: one sign-in per site per run). */
const contexts = new Map();
async function contextFor(browser, base) {
  if (!contexts.has(base)) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce", locale: "en-IN", timezoneId: "Asia/Kolkata" });
    await signIn(ctx, base);
    contexts.set(base, ctx);
  }
  return contexts.get(base);
}

async function shoot(browser, base, theme, [w, h], route) {
  const ctx = await contextFor(browser, base);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  // the same theme on both sites, through each site's own preview link
  await page.goto(`${base}/theme-preview?theme=${theme === "live" ? "off" : theme}&to=${encodeURIComponent(route)}`, { waitUntil: "networkidle" });
  await page.waitForURL((u) => !u.pathname.startsWith("/theme-preview"), { timeout: 15000 }).catch(() => {});
  if (new URL(page.url()).pathname !== route.split("?")[0]) await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
  await settle(page);
  // hide what can never match: the Next dev overlay and the caret
  await page.addStyleTag({ content: `nextjs-portal{display:none!important} *{caret-color:transparent!important}${HIDE ? ` ${HIDE}{visibility:hidden!important}` : ""}` });
  await page.waitForTimeout(150);
  const buf = await page.screenshot({ fullPage: FULL });
  await page.close();
  return PNG.sync.read(buf);
}

function pad(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0);
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const rows = [];
  let failed = false;
  // sign in one site after the other: a second one-time code would replace the first
  await contextFor(browser, REF);
  await contextFor(browser, NG);
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      for (const route of ROUTES) {
        const name = `${AS}${ADMIN_LAYOUT ? `-${ADMIN_LAYOUT}` : ""}-${theme}-${vp.join("x")}-${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}`;
        try {
          const [a, b] = await Promise.all([shoot(browser, REF, theme, vp, route), shoot(browser, NG, theme, vp, route)]);
          const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
          const A = pad(a, w, h), B = pad(b, w, h);
          const diff = new PNG({ width: w, height: h });
          const n = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
          const pct = (n / (w * h)) * 100;
          fs.writeFileSync(path.join(OUT, `${name}.ref.png`), PNG.sync.write(A));
          fs.writeFileSync(path.join(OUT, `${name}.ng.png`), PNG.sync.write(B));
          fs.writeFileSync(path.join(OUT, `${name}.diff.png`), PNG.sync.write(diff));
          rows.push({ screen: name, size: `${a.width}x${a.height} / ${b.width}x${b.height}`, diffPct: pct.toFixed(3) });
          if (pct > MAX) failed = true;
          console.log(`${pct > MAX ? "DIFF" : "ok  "} ${pct.toFixed(3).padStart(8)}%  ${name}`);
        } catch (e) {
          failed = true;
          rows.push({ screen: name, size: "-", diffPct: `error: ${e.message}` });
          console.log(`ERR  ${name}: ${e.message}`);
        }
      }
    }
  }
  for (const ctx of contexts.values()) await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(OUT, `summary-${AS}.json`), JSON.stringify(rows, null, 2));
  console.table(rows);
  process.exit(failed ? 1 : 0);
})();
