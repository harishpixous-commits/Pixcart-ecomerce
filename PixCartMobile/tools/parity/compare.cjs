// Parity screenshots: the same routes on the reference mobile website and on the Flutter web build, at 390x844,
// and how many pixels match. Uses the Playwright install of the reference repository (no dependencies here).
//
//   node tools/parity/compare.cjs --ref http://localhost:3100 --app http://localhost:3200 --out screenshots \
//        --routes "/,/categories,/p/some-slug" [--login 9999900001] [--full]
//
// Signing in (--login) asks the API for an OTP (dev_otp, test installs only) through each origin, so both browsers
// hold a pc_refresh cookie. A pixel counts as different when a colour channel differs by more than 40 (anti-aliasing
// and font hinting differ between Chrome's text and Flutter's text). Writes <out>/report.json and diff images.

const path = require("path");
const fs = require("fs");

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return acc;
}, []));
const PW = process.env.PLAYWRIGHT || "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/playwright";
const CHROME = process.env.CHROME || "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe";
const { chromium } = require(PW);

const out = path.resolve(args.out || "screenshots");
const routes = (args.routes || "/").split(",").filter(Boolean);
const wait = Number(args.wait || 2500);
fs.mkdirSync(out, { recursive: true });

async function signIn(page, base, phone) {
  const h = { "X-Requested-With": "pixcart" };
  const r = await page.request.post(`${base}/api/auth/otp/request`, { data: { phone, purpose: "signin" }, headers: h });
  const j = await r.json();
  if (!j.dev_otp) throw new Error(`no dev_otp from ${base}: ${JSON.stringify(j)}`);
  const v = await page.request.post(`${base}/api/auth/otp/verify`, { data: { phone, purpose: "signin", code: j.dev_otp }, headers: h });
  if (!v.ok()) throw new Error(`verify failed on ${base}: ${v.status()}`);
}

async function shoot(browser, base, kind) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "networkidle" }).catch(() => {});
  if (args.login) {
    await signIn(page, base, args.login);
    await page.evaluate(() => { try { localStorage.setItem("pc_signed_in", "1"); } catch {} });
  }
  const files = {};
  for (const r of routes) {
    const name = r.replace(/[\/?=&]+/g, "_") || "_";
    await page.goto(`${base}${r}`, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(wait);
    const file = path.join(out, `${name}.${kind}.png`);
    await page.screenshot({ path: file, fullPage: kind === "ref" && args.full === "1" });
    files[r] = file;
  }
  await ctx.close();
  return files;
}

async function diff(browser, a, b, diffFile) {
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const toUrl = (f) => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
  const result = await page.evaluate(async ([ua, ub]) => {
    const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
    x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, w, h).data;
    const out = x.createImageData(w, h);
    let bad = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      const off = d > 40;
      if (off) bad++;
      const g = (da[i] + da[i + 1] + da[i + 2]) / 3;
      out.data[i] = off ? 230 : g * 0.3 + 178; out.data[i + 1] = off ? 30 : g * 0.3 + 178; out.data[i + 2] = off ? 60 : g * 0.3 + 178; out.data[i + 3] = 255;
    }
    x.putImageData(out, 0, 0);
    return { match: Math.round((1 - bad / (w * h)) * 10000) / 100, diff: c.toDataURL("image/png") };
  }, [toUrl(a), toUrl(b)]);
  fs.writeFileSync(diffFile, Buffer.from(result.diff.split(",")[1], "base64"));
  await page.close();
  return result.match;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const ref = await shoot(browser, args.ref || "http://localhost:3100", "ref");
  const app = await shoot(browser, args.app || "http://localhost:3200", "app");
  const report = [];
  for (const r of routes) {
    const name = path.basename(ref[r]).replace(/\.ref\.png$/, "");
    const match = await diff(browser, ref[r], app[r], path.join(out, `${name}.diff.png`));
    report.push({ route: r, match });
    console.log(`${String(match).padStart(6)}%  ${r}`);
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
