const path = require("path");
const { chromium } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3200/delivery/join", { waitUntil: "networkidle" });
  const cdp = await ctx.newCDPSession(p);
  let n = 0; const t0 = Date.now(); let last;
  while (Date.now() - t0 < 4000) { const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 82, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 390, height: 844, scale: 2 } }); last = r.data; n++; }
  require("fs").writeFileSync(process.argv[2] + "/loop.jpg", Buffer.from(last, "base64"));
  console.log("fps", (n / 4).toFixed(1));
  await b.close();
})();
