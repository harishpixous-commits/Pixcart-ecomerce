import { expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { collectErrors, test } from "./helpers";

/*
 * Storefront themes: every theme renders the shop and keeps the core shopping flow working (search, product page,
 * add to cart, cart), on a phone and a desktop; previews stay in the admin's own browser; the shop always ends on the
 * Classic theme with the brand colours.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const THEMES = ["bazaar", "fresh", "luxe", "classic"] as const;
const SINGLE = "/p/vitamin-c-face-serum-30ml"; // one version: Add to cart straight away

async function adminApi(): Promise<{ api: APIRequestContext; token: string }> {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const r = await api.post("/api/auth/login", {
    data: { email: process.env.ADMIN_EMAIL ?? "admin@pixcart.in", password: process.env.ADMIN_PASSWORD ?? "PixCart@Admin2026" },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return { api, token: (await r.json()).access_token };
}

async function setTheme(api: APIRequestContext, token: string, theme: string, settings: Record<string, unknown> = {}) {
  const r = await api.put("/api/admin/storefront/theme", { data: { theme, settings }, headers: { Authorization: `Bearer ${token}` } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

async function shopFlow(page: Page, theme: string) {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator(`[data-theme="${theme}"]`)).toHaveCount(1);
  await expect(page.getByTestId("product-tile").first()).toBeVisible();

  // search from the header
  const search = page.locator("#site-search");
  if (!(await search.isVisible())) await page.getByRole("button", { name: /search/i }).first().click(); // Luxe opens a search panel
  await page.locator("#site-search").fill("serum");
  await page.locator("#site-search").press("Enter");
  await expect(page.getByTestId("results-count")).toContainText(/result/);
  await expect(page.getByTestId("product-tile").first()).toBeVisible();

  // product page → add to cart → the cart shows it
  await page.goto(SINGLE);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart", exact: true }).first().click();
  await expect(page.getByText(/Added to your cart|in your cart|only \d+ left/i).first()).toBeVisible();
  await page.goto("/cart");
  await expect(page.getByText(/Vitamin C/i).first()).toBeVisible();
  expect(errors).toEqual([]);
}

test.describe.serial("storefront themes", () => {
  let api: APIRequestContext;
  let token: string;

  test.beforeAll(async () => {
    ({ api, token } = await adminApi());
  });

  test.afterAll(async () => {
    // the shop always ends on Classic with its own layout and the brand colours
    await setTheme(api, token, "classic", { classic: {} });
    await api.dispose();
  });

  test("a preview shows only in this browser, with a bar to leave it", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/theme-preview?theme=luxe&preset=emerald&to=/deals");
    await expect(page).toHaveURL(/\/deals$/);
    await expect(page.locator('[data-theme="luxe"]')).toHaveCount(1);
    await expect(page.getByTestId("theme-preview-bar")).toContainText("Luxe");

    // another visitor still sees the live theme
    const other = await browser.newContext();
    const shopper = await other.newPage();
    await shopper.goto("/");
    await expect(shopper.locator('[data-theme="classic"]')).toHaveCount(1);
    await other.close();

    await page.getByTestId("theme-preview-exit").click();
    await expect(page.locator('[data-theme="classic"]')).toHaveCount(1);
    await expect(page.getByTestId("theme-preview-bar")).toHaveCount(0);
    await ctx.close();
  });

  for (const theme of THEMES) {
    test(`${theme}: home, search, product page and cart work on a phone and a computer`, async ({ browser }) => {
      await setTheme(api, token, theme);
      for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 900 }]) {
        const ctx = await browser.newContext({ viewport });
        const page = await ctx.newPage();
        await shopFlow(page, theme);
        // no sideways scrolling on any of these screens
        for (const path of ["/", "/search?q=shoes", SINGLE, "/cart", "/login"]) {
          await page.goto(path);
          await page.waitForLoadState("networkidle");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${theme} ${viewport.width}px ${path} scrolls sideways`).toBeLessThanOrEqual(1);
        }
        await ctx.close();
      }
    });
  }

  test("the owner previews and applies a theme from the admin panel, then switches back", async ({ admin, browser }) => {
    const errors = collectErrors(admin);
    await admin.goto("/admin/storefront?tab=theme");
    await admin.getByTestId("theme-editor").waitFor();
    await admin.getByTestId("theme-card-bazaar").click();
    await admin.getByTestId("preset-crimson").click();
    await expect(admin.getByText("unsaved changes")).toBeVisible();

    // the live preview shows the real shop in the draft
    await admin.getByTestId("theme-preview-open").click();
    const frame = admin.frameLocator('[data-testid="theme-live-preview"] iframe');
    await expect(frame.locator('[data-theme="bazaar"]')).toHaveCount(1, { timeout: 60_000 });
    await admin.getByRole("button", { name: "Close the preview" }).click();

    // apply: shoppers get Bazaar with the Crimson preset
    await admin.getByTestId("theme-apply").click();
    await admin.getByTestId("theme-apply-confirm").click();
    await expect(admin.getByText("The shop now uses Bazaar.")).toBeVisible();
    const shopper = await browser.newContext();
    const page = await shopper.newPage();
    await page.goto("/");
    await expect(page.locator('[data-theme="bazaar"]')).toHaveCount(1);
    await shopper.close();

    // and back to Classic (its own preset and layout untouched)
    await admin.getByTestId("theme-card-classic").click();
    await admin.getByTestId("theme-apply").click();
    await admin.getByTestId("theme-apply-confirm").click();
    await expect(admin.getByText("The shop now uses Classic.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("layout changes apply without changing the theme", async ({ browser }) => {
    await setTheme(api, token, "classic", { classic: { layout: { productGrid: "cards", filters: "topbar" } } });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/search?q=shoes");
    await expect(page.locator('[data-theme="classic"][data-grid="cards"]')).toHaveCount(1);
    await ctx.close();
    await setTheme(api, token, "classic", { classic: {} });
  });
});
