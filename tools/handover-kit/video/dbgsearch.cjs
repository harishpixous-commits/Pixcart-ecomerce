const path = require("path");
const { chromium } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto("http://localhost:3200/", { waitUntil: "networkidle" });
  const box = p.locator("#site-search");
  await box.click(); await box.pressSequentially("bluetooth speaker", { delay: 60 }); await p.waitForTimeout(800); await box.press("Enter");
  await p.waitForTimeout(4000);
  console.log(p.url());
  console.log((await p.locator("a[href*='/p/']").evaluateAll((as) => as.slice(0, 6).map((a) => a.getAttribute("href")))).join("\n"));
  await p.screenshot({ path: process.argv[2] + "/search.png" });
  await b.close();
})();
