import { expect, test } from "@playwright/test";
import { collectErrors, otpLogin, randomPhone } from "./helpers";

// Runs on the demo data from `seed --demo` plus `python -m scripts.demo_promotions` (deals and ad campaigns).
const SAREE = "/p/kanchipuram-art-silk-saree-with-blouse-piece"; // sold by Chennai Silks & Co (seller phone 9000000001)
const COFFEE = "/p/filter-coffee-powder-500g-80-20";

test("header: All menu, department search and the discovery pages", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await page.getByTestId("all-menu").click();
  const menu = page.getByRole("dialog", { name: "All categories and pages" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: /Today's Deals/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Today's Deals" }).first().click();
  await page.waitForURL("**/deals");
  await expect(page.getByTestId("deals-grid")).toBeVisible();
  await page.goto("/bestsellers");
  await expect(page.getByRole("heading", { name: /Best ?sellers/i }).first()).toBeVisible();
  await page.goto("/coupons");
  await expect(page.getByTestId("coupons")).toBeVisible();
  expect(errors).toEqual([]);
});

test("search shows Sponsored results, compare puts products side by side", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/search?q=earbuds");
  await expect(page.getByTestId("results-count")).toBeVisible();
  await expect(page.getByTestId("sponsored-label").first()).toBeVisible();
  const toggles = page.getByTestId("compare-toggle");
  await toggles.nth(0).locator("input").check();
  await toggles.nth(1).locator("input").check();
  const tray = page.getByTestId("compare-tray");
  await expect(tray).toBeVisible();
  await tray.getByRole("link", { name: /Compare \(2\)/ }).click();
  await page.waitForURL("**/compare?ids=*");
  await expect(page.locator("[data-testid=compare-table] tbody tr").first()).toBeVisible();
  await page.getByLabel("Show only differences").check();
  await expect(page.locator("[data-testid=compare-table] tbody tr").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("questions: guests read, a shopper asks, the seller answers from the seller hub", async ({ page, browser }) => {
  await page.goto(SAREE);
  const qa = page.getByTestId("questions");
  await qa.scrollIntoViewIfNeeded();
  await expect(qa.getByRole("link", { name: "Sign in" })).toBeVisible();

  await page.goto(`/login?next=${encodeURIComponent(SAREE)}`);
  await otpLogin(page, randomPhone("96"), "Question Tester");
  await page.waitForURL(`**${SAREE}`);
  const text = `Is the blouse piece stitched or unstitched? (${Date.now() % 100000})`;
  await page.getByTestId("questions").locator("textarea").first().fill(text);
  await page.getByTestId("questions").getByRole("button", { name: /Post question|Ask/ }).click();
  await expect(page.getByText(/question (is|was) (posted|published)|Thanks/i).first()).toBeVisible();

  const seller = await (await browser.newContext()).newPage();
  await seller.goto("/login?next=/seller/questions");
  await otpLogin(seller, "9000000001");
  await seller.waitForURL("**/seller/questions");
  const card = seller.getByTestId("seller-question").filter({ hasText: text });
  await expect(card).toBeVisible();
  await card.locator("textarea").fill("Unstitched, 0.8 m running blouse piece.");
  await card.getByRole("button", { name: "Post answer" }).click();
  await expect(seller.getByText("Answer posted on the product page").first()).toBeVisible();

  await page.reload();
  await page.getByTestId("questions").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("questions")).toContainText("Unstitched, 0.8 m running blouse piece.");
});

test("cart: save for later and move back to the cart", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent(COFFEE)}`);
  await otpLogin(page, randomPhone("95"), "Saver Tester");
  await page.waitForURL(`**${COFFEE}`);
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await page.goto("/cart");
  const line = page.getByTestId("cart-line").first();
  await expect(line).toBeVisible();
  await line.getByRole("button", { name: /Save for later/ }).click();
  const saved = page.getByTestId("saved-for-later");
  await expect(saved).toBeVisible();
  await saved.getByRole("button", { name: /Move to cart/ }).first().click();
  await expect(page.getByTestId("cart-line").first()).toBeVisible();
});
