import { expect, type Page } from "@playwright/test";
import { collectErrors, otpLogin, randomPhone, test } from "./helpers";

const PRODUCT = "/p/men-s-pure-cotton-slim-fit-casual-shirt";

test.describe.serial("order to refund, across customer, seller and admin", () => {
  let buyer: Page;
  let orderPath = "";
  let orderNumber = "";

  test.beforeAll(async ({ browser }) => {
    buyer = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  });
  test.afterAll(async () => buyer.context().close());

  test("customer buys with a coupon and cash on delivery", async () => {
    const page = buyer;
    const errors = collectErrors(page);
    await page.goto("/");
    await expect(page.getByText("Deals of the day").first()).toBeVisible();

    await page.locator("#site-search").fill("shirt");
    await page.locator("#site-search").press("Enter");
    await expect(page.getByText("Results for").first()).toBeVisible();

    await page.goto(PRODUCT);
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await expect(page.getByText("Added to your cart").first()).toBeVisible();

    await page.goto("/cart");
    await page.getByText("Sign in to place order").click();
    const phone = randomPhone("98");
    await otpLogin(page, phone, "Lakshmi");
    await page.waitForURL("**/checkout");

    await expect(page.getByText("Delivery address").first()).toBeVisible();
    await page.getByLabel("Full name").fill("Lakshmi R");
    await page.locator("input[autocomplete=tel-national]").fill(phone);
    await page.locator("input[autocomplete=address-line1]").fill("22 Gandhi Street, T Nagar");
    await page.locator("input[autocomplete=postal-code]").fill("600017");
    await page.locator("input[autocomplete=address-level2]").fill("Chennai");
    await page.getByRole("button", { name: "Save address" }).click();
    await expect(page.getByText("Review items").first()).toBeVisible();

    await page.getByLabel("Coupon code").fill("WELCOME10");
    await page.getByRole("button", { name: "Apply", exact: true }).first().click();
    await expect(page.getByText(/WELCOME10\s+applied/).first()).toBeVisible();

    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByText("Package 1 of 1").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Coupon WELCOME10").first()).toBeVisible();
    orderPath = new URL(page.url()).pathname;
    orderNumber = ((await page.locator("h1").first().textContent()) ?? "").replace("Order", "").trim();
    expect(orderNumber).toMatch(/^PC/);
    expect(errors).toEqual([]);
  });

  test("seller confirms, packs, ships and delivers", async ({ seller }) => {
    await seller.goto("/seller/orders?status=placed");
    // New orders queue oldest first, so find this one by its number.
    await seller.getByLabel("Search orders").fill(orderNumber);
    await seller.getByRole("link", { name: `${orderNumber}-1` }).click();
    await seller.getByRole("button", { name: "Confirm order" }).click();
    await seller.getByRole("button", { name: "Mark as packed" }).click();
    await seller.getByRole("button", { name: /Add shipping details|Ship on my own/ }).click();
    await seller.getByLabel("Courier").fill("Delhivery");
    await seller.getByLabel("Tracking number (AWB)").fill("DLV" + Date.now());
    await seller.locator("form").getByRole("button", { name: "Mark as shipped" }).click();
    await expect(seller.getByRole("button", { name: /Invoice / })).toBeVisible();
    await seller.getByRole("button", { name: "Mark as delivered" }).click();
    await expect(seller.getByText("Delivered").first()).toBeVisible();
  });

  test("customer sees the invoice and requests a return", async () => {
    const page = buyer;
    await page.goto(orderPath);
    await expect(page.getByRole("button", { name: /Invoice / })).toBeVisible();
    await page.getByRole("button", { name: "Return items" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Quantity to return/).first().selectOption("1");
    await dialog.getByLabel("Why are you returning?").selectOption({ label: "Size or fit is not right" });
    await dialog.getByLabel("UPI ID for your refund").fill("lakshmi@okaxis");
    await dialog.getByRole("button", { name: "Request return" }).click();
    await expect(page.getByText("Waiting for the seller").first()).toBeVisible();
  });

  test("seller approves and receives the return; admin records the UPI refund", async ({ seller, admin }) => {
    await seller.goto("/seller/returns");
    const card = seller.locator("section", { hasText: `${orderNumber}-1` });
    await card.getByRole("button", { name: "Approve return" }).click();
    await expect(seller.getByText("Return updated").first()).toBeVisible();
    await seller.getByRole("tab", { name: /Awaiting pickup/ }).click();
    await seller.locator("section", { hasText: `${orderNumber}-1` }).getByRole("button", { name: "Mark received and refund" }).click();
    await expect(seller.getByText("Return updated").first()).toBeVisible();

    await admin.goto("/admin/returns");
    await admin.getByRole("tab", { name: /Received, refund due/ }).click();
    await admin.locator("section", { hasText: `${orderNumber}-1` }).getByRole("button", { name: "Record UPI refund" }).click();
    await admin.getByLabel("UPI / bank reference").fill("UPI" + Date.now());
    await admin.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(admin.getByText("Return updated").first()).toBeVisible();

    await buyer.goto(orderPath);
    await expect(buyer.getByText("Refunded").first()).toBeVisible();
  });
});

test("admin rebrands the storefront from the panel", async ({ admin }) => {
  await admin.goto("/admin/storefront?tab=brand");
  const name = admin.getByLabel("Store name");
  const original = await name.inputValue();
  await name.fill("Kadai Test");
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText(/^Saved\./).first()).toBeVisible();
  expect((await (await admin.request.get("/api/site")).json()).brand_name).toBe("Kadai Test");

  await name.fill(original);
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText(/^Saved\./).first()).toBeVisible();
});

test("seller hub and admin pages open without errors", async ({ admin, seller }) => {
  const errors = [...collectErrors(admin), ...collectErrors(seller)];
  const adminErrors = collectErrors(admin);
  const sellerErrors = collectErrors(seller);
  for (const path of ["/admin", "/admin/storefront", "/admin/coupons", "/admin/payouts", "/admin/support", "/admin/notifications", "/admin/staff", "/admin/integrations", "/admin/settings", "/admin/reports"]) {
    await admin.goto(path);
    await expect(admin.locator("h1").first()).toBeVisible();
  }
  for (const path of ["/seller/inventory", "/seller/warehouses", "/seller/payouts", "/seller/analytics", "/seller/coupons", "/seller/returns", "/seller/reviews", "/seller/settings"]) {
    await seller.goto(path);
    await expect(seller.locator("h1").first()).toBeVisible();
  }
  expect([...errors, ...adminErrors, ...sellerErrors]).toEqual([]);
});
