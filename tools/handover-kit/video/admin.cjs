/*
 * Video: the admin panel, every section with real actions (computer). Sign in, overview, quick find, orders, returns,
 * refunds, support, customers, the delivery fleet, sellers, approving a new listing, catalogue, money, storefront
 * themes with live preview, marketing, the AI assistant, settings and the four admin layouts.
 *   node admin.cjs <recDir>
 */
const { Recorder, tap, type, scroll, top, go, sleep } = require("./rec.cjs");

const TOTAL = 44;
let n = 0;
const step = () => `Step ${++n}`;

async function view(r, url, text, { down = 500, wait = 2200 } = {}) {
  await r.scene("admin", url, async (p) => {
    await go(p, url, 300);
    await r.cap("admin", text, step());
    await sleep(wait + 900);
    if (down) await scroll(p, down, 1400);
  });
}
async function openFirst(r, list, selector, text) {
  await r.scene("admin", list + "#first", async (p) => {
    await go(p, list, 1000);
    const link = p.locator(selector).first();
    if (!(await link.count())) return;
    await r.cap("admin", text, step());
    await tap(p, link, { after: 2200 });
    await scroll(p, 500, 1500);
  });
}
async function tab(p, name) {
  const t = p.getByRole("tab", { name: new RegExp("^" + name) }).first();
  if (await t.count()) await tap(p, t, { after: 1800 });
}

(async () => {
  const r = new Recorder("admin", process.argv[2]);
  await r.start();
  await r.page("admin", "admin");

  r.card("Sign in and overview", "One place to run the whole marketplace");
  await r.scene("admin", "login", async (p) => {
    await go(p, "/admin/login");
    await r.cap("admin", "Staff sign in with email and password (and two-step sign-in when it is on)", step());
    await type(p, p.getByLabel("Email"), "admin@pixcart.in");
    await type(p, p.getByLabel("Password"), process.env.ADMIN_PW, { delay: 40 });
    await tap(p, p.getByRole("button", { name: "Sign in" }), { after: 1500 });
    await p.waitForURL("**/admin");
    await p.locator("[data-admin-layout]").waitFor();
    await sleep(1200);
    await r.cap("admin", "Overview: sales, orders, tasks waiting and business brief", step());
    await sleep(2500);
    await scroll(p, 600, 1500);
    await scroll(p, 600, 1500);
    await top(p);
  });
  await view(r, "/admin/go-live", "Go-live checklist: everything to set up before opening");
  await r.scene("admin", "quickfind", async (p) => {
    await r.cap("admin", "Quick find (Ctrl+K): jump to any page or find any record", step());
    await p.keyboard.press("Control+k");
    await sleep(800);
    await p.keyboard.type("speaker", { delay: 120 });
    await sleep(2500);
    await p.keyboard.press("Escape");
    await sleep(600);
  });

  r.card("Orders and customers", "Orders, returns, refunds, support and accounts");
  await view(r, "/admin/orders", "Orders: every order with filters and downloads");
  await openFirst(r, "/admin/orders", "a[href^='/admin/orders/']", "Order details: packages, payment, delivery trip, AI risk brief and history");
  await view(r, "/admin/returns?status=", "Returns: requests, pickups and refunds");
  await view(r, "/admin/refunds", "Refunds: retry failed refunds and record UPI or bank refunds");
  await view(r, "/admin/support", "Support desk: customer tickets with due times and AI-drafted replies");
  await view(r, "/admin/customers", "Customers and accounts: search, open, block or unblock");
  await openFirst(r, "/admin/customers", "a[href^='/admin/customers/']", "Customer details: orders, addresses, tickets and account status");

  r.card("Delivery fleet", "Your own delivery partners, live");
  await view(r, "/admin/delivery", "Delivery overview: partners online, trips under way, cash to collect");
  await view(r, "/admin/delivery/live", "Live partners: a live map of partners and trips", { down: 0, wait: 3500 });
  await view(r, "/admin/delivery/queue", "Assign deliveries: offered automatically, or assigned by hand");
  await view(r, "/admin/delivery/trips?status=", "Delivery trips: every trip with its steps, codes, photos and cash");
  await openFirst(r, "/admin/delivery/trips?status=", "a[href^='/admin/delivery/trips/']", "Trip details: the partner, each step with its time, the codes and the proof photo");
  await view(r, "/admin/delivery/partners", "Delivery partners: registrations, document checks and approval");
  await view(r, "/admin/delivery/payouts", "Partner payouts and cash: weekly payouts and cash deposits");
  await view(r, "/admin/delivery/reports", "Delivery reports: delivered and failed trips, cash collected");
  await r.scene("admin", "feedback", async (p) => {
    await go(p, "/admin/delivery/feedback", 1000);
    await r.cap("admin", "Ratings and complaints from customers", step());
    await tab(p, "Ratings");
    await sleep(1800);
  });
  await view(r, "/admin/delivery/zones", "Delivery zones: the areas and PIN codes the fleet serves");
  await view(r, "/admin/delivery/settings", "Delivery settings: fees per trip, bonuses, timers and auto-assign");

  r.card("Sellers and catalogue", "Approve sellers and listings, manage categories and reviews");
  await view(r, "/admin/sellers?status=approved", "Sellers: KYC checks, approval, suspension and commission");
  await openFirst(r, "/admin/sellers?status=approved", "a[href^='/admin/sellers/']", "Seller details: business, documents, listings, orders and payouts");
  await r.scene("admin", "approve", async (p) => {
    await go(p, "/admin/products?status=pending", 1200);
    await r.cap("admin", "Listings to review: the seller's new kurta is waiting", step());
    await sleep(1800);
    const link = p.locator("a[href^='/admin/products/']").first();
    if (await link.count()) {
      await tap(p, link, { after: 2200 });
      await scroll(p, 500, 1500);
      await r.cap("admin", "Checks the photos and details, then approves it: it goes live in the shop", step());
      const approve = p.getByRole("button", { name: "Approve", exact: true }).first();
      if (await approve.count()) await tap(p, approve, { after: 2500 });
    }
  });
  await view(r, "/admin/categories", "Categories: commission, GST, return window and required details");
  await view(r, "/admin/reviews", "Reviews: moderate reviews and customer photos");
  await view(r, "/admin/questions", "Questions: customer questions and answers");

  r.card("Money and reports", "Seller payouts, reports and exports");
  await view(r, "/admin/payouts", "Seller payouts: after commission, GST, TCS and TDS, with bank files");
  await view(r, "/admin/reports", "Reports: sales, GST TCS and performance for any period");
  await view(r, "/admin/exports", "Exports: any list as Excel, CSV or PDF");

  r.card("Store and marketing", "Themes, home page, fees, coupons, deals, ads and messages");
  await r.scene("admin", "theme", async (p) => {
    await go(p, "/admin/storefront?tab=theme", 1500);
    await r.cap("admin", "Theme and layout: four themes, ready colour sets and layout options", step());
    await sleep(2000);
    await tap(p, p.getByTestId("theme-card-luxe"), { after: 1500 });
    await r.cap("admin", "Live preview: see the real shop in a theme before applying it", step());
    await tap(p, p.getByTestId("theme-preview-open"), { after: 6000 });
    await tap(p, p.getByRole("button", { name: "Close the preview" }), { after: 1200 });
    await tap(p, p.getByTestId("theme-card-classic"), { after: 1200 });
  });
  await view(r, "/admin/storefront?tab=home", "Home page editor: banners, product rows, images and videos, drag to reorder");
  await view(r, "/admin/storefront?tab=brand", "Brand and colours: shop name, logo and colours");
  await view(r, "/admin/product-page", "Product page: switch every block on or off");
  await view(r, "/admin/checkout", "Checkout and fees: every fee with a live bill preview");
  await view(r, "/admin/coupons", "Coupons: limits, dates and who pays for the discount");
  await view(r, "/admin/deals", "Deals: approve and schedule sellers' deals");
  await view(r, "/admin/advertising", "Advertising: sponsored products, budgets and billing");
  await view(r, "/admin/notifications", "Messages: every app, email, SMS and WhatsApp message, with editable text");

  r.card("AI", "An assistant that answers with your live figures");
  await r.scene("admin", "assistant", async (p) => {
    await go(p, "/admin", 1200);
    await r.cap("admin", "AI assistant: ask in plain words, get live figures and charts", step());
    await tap(p, p.getByRole("button", { name: /Open the AI assistant/ }), { after: 1500 });
    await type(p, p.locator("#assistant-input"), "How were sales in the last 30 days?", { delay: 45 });
    await p.locator("#assistant-input").press("Enter");
    await sleep(9000);
  });
  await view(r, "/admin/ai", "AI studio: drafts descriptions and replies for people to review");
  await view(r, "/admin/shop-assistant", "Shopping assistant: the customer chat, its features and help articles");

  r.card("Administration", "Settings, sign-in rules, keys, staff and the audit log");
  await view(r, "/admin/settings", "Marketplace settings: fees, taxes, order rules, lists, maintenance mode", { down: 900 });
  await view(r, "/admin/sign-in", "Sign-in and accounts: code rules, passwords, sessions and two-step sign-in", { down: 900 });
  await view(r, "/admin/integrations", "Integrations: payments, SMS, email, WhatsApp and AI keys, kept encrypted");
  await view(r, "/admin/staff", "Staff and roles: each person sees only what their role allows");
  await view(r, "/admin/audit", "Audit log: who changed what, and when");
  await r.scene("admin", "layouts", async (p) => {
    await go(p, "/admin/account", 1500);
    await r.cap("admin", "My account: each staff member picks their admin layout", step());
    for (const l of ["topnav", "rail", "glass"]) {
      await tap(p, p.getByTestId(`admin-layout-${l}`), { after: 2600 });
    }
    const reset = p.getByRole("button", { name: /Use the default/ });
    if (await reset.count()) await tap(p, reset, { after: 2000 });
  });
  await r.finish();
})().catch((e) => { console.error(e); process.exit(1); });
