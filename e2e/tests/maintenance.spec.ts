import { expect, request as pwRequest } from "@playwright/test";
import { collectErrors, test } from "./helpers";

/*
 * Maintenance mode: the owner closes the shop from Marketplace settings; shoppers see the "back soon" page on a phone
 * and a computer, sign-in and policy pages stay open, staff see the shop with a reminder bar; switched off, the shop
 * is back.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const DEFAULT_MESSAGE = "We are making a few improvements and will be back shortly. Thank you for your patience.";

async function setMaintenance(on: boolean, message?: string) {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const r = await api.post("/api/auth/login", {
    data: { email: process.env.ADMIN_EMAIL ?? "admin@pixcart.in", password: process.env.ADMIN_PASSWORD ?? "PixCart@Admin2026" },
  });
  const token = (await r.json()).access_token;
  const s = await api.put("/api/admin/settings", { data: { maintenance_mode: on, ...(message ? { maintenance_message: message } : {}) }, headers: { Authorization: `Bearer ${token}` } });
  expect(s.ok(), await s.text()).toBeTruthy();
  await api.dispose();
}

test.describe.serial("maintenance mode", () => {
  test.afterAll(async () => {
    await setMaintenance(false, DEFAULT_MESSAGE); // never leave the shop closed
  });

  test("the owner switches it on from Marketplace settings", async ({ admin }) => {
    const errors = collectErrors(admin);
    await admin.goto("/admin/settings");
    const section = admin.getByTestId("maintenance-settings");
    await section.getByLabel("Message shoppers see").fill("Back at 6 pm after a stock update.");
    await admin.getByTestId("maintenance-toggle").check();
    await admin.getByRole("button", { name: "Save settings" }).click();
    await expect(admin.getByText("Settings saved").first()).toBeVisible();
    await expect(section.getByText("On now")).toBeVisible();

    // staff still see the shop, with the reminder bar
    await admin.goto("/");
    await expect(admin.getByTestId("maintenance-bar")).toBeVisible();
    await expect(admin.getByTestId("product-tile").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const [name, viewport] of [["phone", { width: 390, height: 844 }], ["computer", { width: 1440, height: 900 }]] as const) {
    test(`shoppers on a ${name} see the message; sign-in and policies stay open`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      const errors = collectErrors(page);
      for (const path of ["/", "/search?q=serum", "/cart"]) {
        await page.goto(path);
        await expect(page.getByTestId("maintenance-page")).toBeVisible();
        await expect(page.getByText("Back at 6 pm after a stock update.")).toBeVisible();
        await expect(page.getByTestId("product-tile")).toHaveCount(0);
      }
      await page.goto("/login");
      await expect(page.getByTestId("maintenance-page")).toHaveCount(0);
      await page.goto("/pages/terms");
      await expect(page.getByTestId("maintenance-page")).toHaveCount(0);
      expect(errors).toEqual([]);
      await ctx.close();
    });
  }

  test("switched off, shoppers see the shop again", async ({ browser }) => {
    await setMaintenance(false);
    const page = await (await browser.newContext()).newPage();
    await page.goto("/");
    await expect(page.getByTestId("maintenance-page")).toHaveCount(0);
    await expect(page.getByTestId("product-tile").first()).toBeVisible();
  });
});
