const path = require("path"); const fs = require("fs");
const { chromium } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  let n = 0, sizes = new Set(); const t0 = Date.now();
  cdp.on("Page.screencastFrame", async (f) => { n++; const buf = Buffer.from(f.data, "base64"); if (n === 20) fs.writeFileSync(process.argv[2] + "/cdp.jpg", buf); sizes.add(f.metadata.deviceWidth + "x" + f.metadata.deviceHeight); await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 780, maxHeight: 1688 });
  await p.goto("http://localhost:3200/delivery/join", { waitUntil: "networkidle" });
  for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, 40); await new Promise((r) => setTimeout(r, 50)); }
  await new Promise((r) => setTimeout(r, 1500));
  console.log("frames", n, "in", ((Date.now() - t0) / 1000).toFixed(1), "s; metadata", [...sizes].join(","));
  await b.close();
})();
