import { expect, test } from "@playwright/test";
import { adminLogin, collectErrors, otpLogin, randomPhone } from "./helpers";

// Seeded by `seed --demo` with net quantity, FSSAI licence and other product information (scripts/demo_details.json).
const COFFEE = "/p/filter-coffee-powder-500g-80-20";

test("product page for a guest: unit price, offers, delivery PIN, product information, reviews read-only", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(COFFEE);
  await expect(page.getByText(/\/ 100 g/).first()).toBeVisible();
  await expect(page.getByTestId("offer").first()).toBeVisible();

  await page.getByTestId("deliver-to").click();
  await page.locator("#hdr-pin").fill("600028");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("delivery")).toContainText("Delivering to 600028");

  await expect(page.getByRole("heading", { name: "Product information" })).toBeVisible();
  await expect(page.getByText("FSSAI licence").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Important information" })).toBeVisible();
  // anyone reads reviews; writing and reporting need an account
  await expect(page.getByRole("heading", { name: "Customer reviews" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to write a review" })).toBeVisible();
  await expect(page.getByText("Sign in to report an issue with this product")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a signed-in shopper reports a product and staff resolve it", async ({ page, browser }) => {
  await page.goto(`/login?next=${encodeURIComponent(COFFEE)}`);
  await otpLogin(page, randomPhone("97"), "Report Tester");
  await page.waitForURL(`**${COFFEE}`);
  await page.getByTestId("report-product").click();
  await page.getByLabel("Wrong or missing product information").check();
  await page.getByRole("dialog").locator("textarea").fill("The net quantity printed on the pack is different");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Our team will look into it")).toBeVisible();

  const admin = await (await browser.newContext()).newPage();
  await adminLogin(admin);
  await admin.goto("/admin/product-reports");
  const card = admin.getByTestId("product-report").filter({ hasText: "printed on the pack" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Report Tester");
  await card.getByRole("button", { name: "Dismiss" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
});

test("admin controls product page blocks and review settings", async ({ page }) => {
  const errors = collectErrors(page);
  await adminLogin(page);
  await page.goto("/admin/product-page");
  const share = page.getByTestId("toggle-pdp_share");
  await share.uncheck();
  await page.getByRole("button", { name: "Save product page settings" }).click();
  await expect(page.getByText("Product page settings saved").first()).toBeVisible();
  expect((await (await page.request.get("/api/site")).json()).pdp.share).toBe(false);
  await share.check();
  await page.getByRole("button", { name: "Save product page settings" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/site")).json()).pdp.share).toBe(true);

  await page.goto("/admin/reviews");
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByText("Verified buyers only (recommended)")).toBeVisible();
  await expect(page.getByText("What customers talk about")).toBeVisible();

  await page.goto("/admin/categories");
  await page.getByRole("row").filter({ hasText: "Snacks & Beverages" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("dialog").getByText("FSSAI licence number")).toBeVisible();
  expect(errors).toEqual([]);
});
