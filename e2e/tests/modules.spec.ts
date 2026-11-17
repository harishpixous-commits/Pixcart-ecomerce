import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { collectErrors, test } from "./helpers";

test("admin manages business details, contact and social links, and the shop follows", async ({ admin, browser }) => {
  const errors = collectErrors(admin);
  await admin.goto("/admin/storefront?tab=business");
  // Start from a known state whatever an earlier run saved.
  await admin.getByRole("switch", { name: /Show social media links/ }).check();
  while (await admin.getByRole("button", { name: "Remove Instagram" }).count()) await admin.getByRole("button", { name: "Remove Instagram" }).first().click();
  while (await admin.getByRole("button", { name: "Remove Customer care" }).count()) await admin.getByRole("button", { name: "Remove Customer care" }).first().click();
  await admin.getByLabel("Registered business name", { exact: true }).fill("Kadai Retail Private Limited");
  await admin.getByLabel("Registered address", { exact: true }).fill("12 Anna Salai, Chennai 600002");
  await admin.getByLabel("Name", { exact: true }).fill("Meena R");
  await admin.getByLabel("Email", { exact: true }).fill("grievance@kadai.in");

  // Contact: add a customer-care phone.
  await admin.getByRole("button", { name: "Add phone", exact: true }).click();
  const phoneRow = admin.locator("li", { has: admin.getByPlaceholder("+91 44 4000 1234") }).last();
  await phoneRow.getByPlaceholder("+91 44 4000 1234").fill("+91 44 4000 1234");

  // Social: add Instagram and a platform of your own.
  await admin.getByRole("button", { name: "Add Instagram", exact: true }).click();
  await admin.getByPlaceholder("https://instagram.com/yourshop").fill("https://instagram.com/kadai.test");
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText(/^Saved\. The shop shows the change now/).first()).toBeVisible();

  const shop = await (await browser.newContext()).newPage();
  await shop.goto("/contact");
  await expect(shop.getByRole("heading", { name: "Registered office" })).toBeVisible();
  await expect(shop.getByText("Kadai Retail Private Limited").first()).toBeVisible();
  await expect(shop.locator('a[href="tel:+914440001234"]').first()).toBeVisible();
  const insta = shop.locator('footer a[href="https://instagram.com/kadai.test"]');
  await expect(insta).toHaveAttribute("rel", /noopener/);
  await shop.goto("/help/grievance");
  await expect(shop.getByText("Meena R").first()).toBeVisible();

  // Switch the social module off: the icons disappear everywhere.
  await admin.getByRole("switch", { name: /Show social media links/ }).uncheck();
  await Promise.all([
    admin.waitForResponse((r) => r.url().endsWith("/api/admin/storefront/site") && r.request().method() === "PUT" && r.ok()),
    admin.getByRole("button", { name: "Save changes" }).click(),
  ]);
  const site = await (await admin.request.get("/api/site")).json();
  expect(site.social.enabled).toBe(false);
  expect(site.social.links.some((l: { url: string }) => l.url === "https://instagram.com/kadai.test")).toBe(true);

  // An unsafe link is refused with a clear message.
  await admin.getByPlaceholder("https://instagram.com/yourshop").fill("javascript:alert(1)");
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText(/must be a full address starting with https/).first()).toBeVisible();
  await admin.getByRole("button", { name: "Discard" }).click();
  expect(errors).toEqual([]);
});

test("export centre downloads CSV files with the right content", async ({ admin, seller }) => {
  await admin.goto("/admin/exports");
  const card = admin.locator("section", { has: admin.getByRole("heading", { name: "Orders (one row per package)" }) });
  const [file] = await Promise.all([admin.waitForEvent("download"), card.getByRole("button", { name: "Download CSV" }).click()]);
  expect(file.suggestedFilename()).toMatch(/-orders-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync(await file.path(), "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text.split("\r\n")[0]).toContain("Package,Order,Placed (IST)");
  await expect(card.getByText(/^Saved /)).toBeVisible();

  // A range longer than a year is refused with the API's message.
  await card.getByLabel("From").fill("2024-01-01");
  await card.getByRole("button", { name: "Download CSV" }).click();
  await expect(card.getByText(/at most 366 days/)).toBeVisible();

  await seller.goto("/seller/exports");
  const stock = seller.locator("section", { has: seller.getByRole("heading", { name: "Stock", exact: true }) });
  const [sf] = await Promise.all([seller.waitForEvent("download"), stock.getByRole("button", { name: "Download CSV" }).click()]);
  expect(readFileSync(await sf.path(), "utf8").split("\r\n")[0]).toContain("sku,warehouse_code,quantity");
});

test("seller bulk-uploads listings: check first, then create drafts", async ({ seller }) => {
  const sku = `E2E-${Date.now().toString(36).toUpperCase()}`;
  const csv = [
    "product_key,title,category,brand,description,highlights,hsn_code,gst_rate,return_window_days,country_of_origin,sku,option_1_name,option_1_value,option_2_name,option_2_value,mrp,price,stock,weight_grams",
    `P1,Test Brand Cotton Kitchen Towel Set of 4,Kitchen & Dining,TestBrand,Soft absorbent cotton towels for daily kitchen use.,Pack of 4|Cotton,6302,5,7,India,${sku}-A,,,,,499,299,40,300`,
    `P2,Bad,Nowhere,,,,12,,,,${sku}-B,,,,,100,200,1,`,
  ].join("\n");
  await seller.goto("/seller/products/import");
  await seller.locator("input[type=file]").setInputFiles({ name: "listings.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await seller.getByRole("button", { name: "Check file" }).click();
  await expect(seller.getByText("not found").first()).toBeVisible();
  await seller.getByRole("button", { name: "Create 1 draft" }).click();
  await expect(seller.getByText(/1 draft created; 1 skipped/)).toBeVisible();
});
