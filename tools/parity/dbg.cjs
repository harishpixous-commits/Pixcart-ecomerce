const { chromium } = require("C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/e2e/node_modules/@playwright/test");
(async () => {
  const b = await chromium.launch({ executablePath: "C:/Users/haris/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe" });
  const p = await b.newPage();
  p.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 300)));
  p.on("pageerror", (e) => console.log("pageerror:", e.message));
  await p.goto(process.argv[2], { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  console.log("url", p.url());
  console.log("cookie", await p.evaluate(() => document.cookie));
  console.log(await p.evaluate(process.argv[3] || "document.title"));
  await b.close();
})();
