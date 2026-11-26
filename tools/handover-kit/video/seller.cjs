/*
 * Video: the seller hub, start to finish (computer). Sign in, dashboard, add a product with photos, products,
 * inventory, warehouses, an order from confirm to shipped by courier, returns, deals, advertising, coupons,
 * questions, reviews, customer reports, payouts, analytics, reports and store settings.
 *   node seller.cjs <recDir>
 */
const path = require("path");
const { Recorder, tap, type, scroll, top, go, otpSignIn, apiAs, sleep } = require("./rec.cjs");

const PHOTOS = ["p09-1.jpg"].map((f) => path.join(process.env.DEMO_IMAGES, f));
const TOTAL = 25;
let n = 0;
const step = () => `Step ${++n}`;

/** A customer order for this seller, waiting to be confirmed (placed through the API before recording). */
async function orderForSeller() {
  const c = await apiAs("9876500011", "Priya Sharma");
  const p = await c.get("/api/catalog/products/kanchipuram-art-silk-saree-with-blouse-piece");
  await c.post("/api/cart/items", { variant_id: p.variants[0].id, qty: 1 });
  const a = await (await c.post("/api/addresses", { full_name: "Priya Sharma", phone: "9876500011", line1: "14 Gandhi Street", line2: "T Nagar",
    city: "Chennai", state_code: "33", pincode: "600017", is_default: true })).json();
  const o = await (await c.post("/api/orders", { address_id: a.id, payment_method: "cod", idempotency_key: `seller-video-${Date.now()}` })).json();
  await c.dispose();
  return o.order.number;
}

(async () => {
  const orderNo = await orderForSeller();
  const r = new Recorder("seller", process.argv[2]);
  await r.start();
  const s = await r.page("seller", "seller");

  r.card("Sign in and dashboard", "Sellers sign in with their mobile number");
  await r.scene("seller", "signin", async (p) => {
    await go(p, "/login?next=/seller");
    await r.cap("seller", "The seller signs in with a mobile number and a one-time code", step());
    await otpSignIn(p, "9000000001");
    await p.waitForURL((u) => u.pathname === "/seller", { timeout: 60000 });
    await sleep(1500);
    await r.cap("seller", "Dashboard: orders to confirm, pack and ship, sales, payout and stock alerts", step());
    await sleep(3000);
    await scroll(p, 400, 2000);
    await top(p);
  });

  r.card("Add a product", "Photos, price, stock and details, then send it for review");
  await r.scene("seller", "new", async (p) => {
    await go(p, "/seller/products/new", 1500);
    await r.cap("seller", "Adds a new product: title, category and brand", step());
    await type(p, p.getByLabel("Product title"), "Men's Handloom Cotton Kurta, Indigo Print");
    await tap(p, p.locator("#cat"));
    const catValue = await p.locator("#cat option").evaluateAll((os) => (os.find((o) => o.textContent.includes("Men's Clothing")) || os[1]).value);
    await p.locator("#cat").selectOption(catValue);
    await sleep(800);
    await type(p, p.getByLabel("Brand"), "Chennai Silks");
    await r.cap("seller", "Uploads product photos", step());
    await p.locator("input[type=file]").first().setInputFiles(PHOTOS);
    await sleep(3500);
    await r.cap("seller", "Writes the description and highlights", step());
    await type(p, p.getByLabel("Description"), "Soft handloom cotton kurta with an indigo block print, made by weavers in Tamil Nadu. Breathable and easy to wash.", { delay: 18 });
    await type(p, p.getByLabel("Highlights (one per line, up to 10)"), "100% handloom cotton", { delay: 30 });
    await sleep(600);
    await r.cap("seller", "Sets the price, MRP and stock", step());
    const sku = p.getByLabel("SKU").first();
    await sku.scrollIntoViewIfNeeded();
    await type(p, sku, "KURTA-INDIGO-M");
    await type(p, p.getByLabel("MRP").first(), "1999");
    await type(p, p.getByLabel("Selling price").first(), "1299");
    await type(p, p.getByLabel("Stock").first(), "25");
    await sleep(800);
    await r.cap("seller", "Adds the tax details: HSN code and GST rate", step());
    await type(p, p.getByLabel("HSN code"), "6205");
    await scroll(p, 700, 1200);
    await r.cap("seller", "Saves and sends it to the marketplace team for review", step());
    await tap(p, p.getByRole("button", { name: "Save and submit for review" }), { after: 3000 });
  });
  await r.scene("seller", "products", async (p) => {
    await go(p, "/seller/products", 1500);
    await r.cap("seller", "Products: every listing with its status, price and stock", step());
    await sleep(2500);
    await scroll(p, 400, 1500);
    await go(p, "/seller/products/import", 1500);
    await r.cap("seller", "Bulk upload: many products at once from a spreadsheet", step());
    await sleep(2500);
  });
  await r.scene("seller", "inventory", async (p) => {
    await go(p, "/seller/inventory", 1500);
    await r.cap("seller", "Inventory: stock in each warehouse, with history", step());
    await sleep(2500);
    await go(p, "/seller/warehouses", 1500);
    await r.cap("seller", "Warehouses: where stock is kept and shipped from", step());
    await sleep(2500);
  });

  r.card("Fulfil an order", "Confirm, pack and ship with the courier's tracking number");
  await r.scene("seller", "order", async (p) => {
    await go(p, "/seller/orders", 1500);
    await r.cap("seller", `A new order (${orderNo}) is waiting. The seller opens it`, step());
    await sleep(1500);
    await tap(p, p.locator("a[href^='/seller/orders/']", { hasText: orderNo }).first(), { after: 2000 });
    await r.cap("seller", "Checks the items, address and earnings, then confirms the order", step());
    await sleep(1500);
    await tap(p, p.getByRole("button", { name: "Confirm order" }), { after: 2000 });
    await r.cap("seller", "Packs it and marks it packed", step());
    await tap(p, p.getByRole("button", { name: "Mark as packed" }), { after: 2000 });
    await r.cap("seller", "Hands it to the courier: enters the courier and the tracking number", step());
    await tap(p, p.getByRole("button", { name: /Add shipping details|Ship on my own/ }).first(), { after: 1200 });
    const dlg = p.getByRole("dialog");
    await type(p, dlg.getByLabel("Courier"), "DTDC");
    await type(p, dlg.getByLabel("Tracking number (AWB)"), "D7834562190");
    await tap(p, dlg.getByRole("button", { name: "Mark as shipped" }), { after: 2500 });
    await scroll(p, 400, 2000);
  });

  r.card("Grow sales and get paid", "Deals, ads, coupons, questions, reviews, payouts and reports");
  const pages = [
    ["/seller/returns", "Returns: approve, arrange pickup and mark received"],
    ["/seller/deals", "Deals: propose deals and lightning deals for approval"],
    ["/seller/advertising", "Advertising: sponsored product campaigns with a daily budget"],
    ["/seller/coupons", "Coupons: the seller's own discount codes"],
    ["/seller/questions", "Customer questions: answer what shoppers ask on product pages"],
    ["/seller/reviews", "Reviews: reply publicly to customer reviews"],
    ["/seller/payouts", "Payouts: earnings after commission and taxes, and each bank payout"],
    ["/seller/analytics", "Analytics: views, orders and conversion for each product"],
    ["/seller/exports", "Reports: download orders, GST details, returns and stock"],
    ["/seller/settings", "Store settings: name, dispatch days, holiday mode and bank details"],
  ];
  for (const [url, text] of pages) {
    await r.scene("seller", url, async (p) => {
      await go(p, url, 300);
      await r.cap("seller", text, step());
      await sleep(3100);
      await scroll(p, 450, 1500);
    });
  }
  await r.finish();
  console.log("order", orderNo);
})().catch((e) => { console.error(e); process.exit(1); });
