const path = require("path"); const fs = require("fs");
const { chromium } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto("http://localhost:3200/delivery/join", { waitUntil: "networkidle" });
  await p.mouse.wheel(0, 900); await new Promise((r) => setTimeout(r, 800));
  const cdp = await ctx.newCDPSession(p);
  const mm = await cdp.send("Page.getLayoutMetrics"); const v = mm.cssVisualViewport; const t1 = Date.now(); const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80, optimizeForSpeed: true, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 2 } }); console.log("ms", Date.now() - t1);
  fs.writeFileSync(process.argv[2] + "/scrolled.jpg", Buffer.from(r.data, "base64"));
  const m = await cdp.send("Page.getLayoutMetrics"); console.log("scrollY", await p.evaluate(() => scrollY), "visual pageY", m.cssVisualViewport.pageY);
  await b.close();
})();
