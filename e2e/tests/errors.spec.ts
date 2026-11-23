import { expect, type Page } from "@playwright/test";
import { collectErrors, test } from "./helpers";

/** Shop pages stream behind their skeleton, so a missing page may answer 200; it must then tell search engines not to index it. */
async function expectNotIndexed(page: Page, status: number | undefined) {
  expect([200, 404]).toContain(status);
  if (status === 200) await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
}

/* "Page not found" in the shop (inside the theme, with search and suggestions) and in the admin panel (in its shell). */

test("a missing shop page shows the themed page with search and suggestions", async ({ page }) => {
  const errors = collectErrors(page);
  const res = await page.goto("/this-page-does-not-exist");
  await expectNotIndexed(page, res?.status());
  await expect(page.locator("[data-theme]")).toHaveCount(1); // the theme's header and footer are there
  const nf = page.getByTestId("not-found");
  await expect(nf.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Popular right now")).toBeVisible();
  await nf.getByLabel("Search products").fill("serum");
  await nf.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search\?q=serum/);
  expect(errors).toEqual([]);
});

test("a product that is no longer sold gets the same page", async ({ page }) => {
  const res = await page.goto("/p/no-such-product-anywhere");
  await expectNotIndexed(page, res?.status());
  await expect(page.getByTestId("not-found")).toBeVisible();
});

test("a missing admin page stays inside the admin panel", async ({ admin }) => {
  await admin.goto("/admin/no-such-screen");
  await expect(admin.getByTestId("not-found")).toBeVisible();
  await expect(admin.locator("[data-admin-layout]")).toHaveCount(1);
  await admin.getByRole("link", { name: "Back to the overview" }).click();
  await expect(admin).toHaveURL(/\/admin$/);
});
