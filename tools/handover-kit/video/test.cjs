const { Recorder, tap, scroll, go, sleep } = require("./rec.cjs");
(async () => {
  const r = new Recorder("test", process.argv[2]); await r.start();
  const d = await r.page("c", "customer");
  const m = await r.page("p", "partner", { mobile: true });
  await r.scene("c", "home", async (p) => { await go(p, "/"); await r.cap("c", "The customer opens the shop and browses today's deals", "Step 1 of 2"); await sleep(1200); await scroll(p, 700); await tap(p, p.getByRole("link", { name: /Bestsellers/ }).first()); await sleep(1500); });
  r.card("Now the delivery partner", "On a phone");
  await r.scene("p", "login", async (p) => { await go(p, "/delivery/join"); await r.cap("p", "The partner opens the app", "Step 2 of 2"); await sleep(1500); await scroll(p, 500); });
  await r.finish();
})();
