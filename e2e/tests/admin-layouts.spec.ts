import { expect } from "@playwright/test";
import { collectErrors, test } from "./helpers";

/*
 * Admin layouts: a staff member switches between the sidebar, top navigation, compact rail and glass layouts from My
 * account → Appearance; every layout shows the menu and the page; quick find (Ctrl+K) opens a page; the choice is
 * theirs only and goes back to the owner's default at the end.
 */

const LAYOUTS = ["topnav", "rail", "glass", "sidebar"] as const;

test.describe.serial("admin layouts", () => {
  test.afterAll(async ({ admin }) => {
    // back to the owner's default
    await admin.goto("/admin/account");
    await admin.getByTestId("appearance").waitFor();
    const reset = admin.getByRole("button", { name: /Use the default/ });
    if (await reset.count()) await reset.click();
  });

  test("switch layouts from My account; every layout shows the menu and the page", async ({ admin }) => {
    const errors = collectErrors(admin);
    await admin.goto("/admin/account");
    await admin.getByTestId("appearance").waitFor();
    for (const layout of LAYOUTS) {
      await admin.getByTestId(`admin-layout-${layout}`).click();
      await expect(admin.locator(`[data-admin-layout="${layout}"]`)).toHaveCount(1);
      await expect(admin.getByTestId(`admin-layout-${layout}`)).toHaveAttribute("aria-checked", "true");
      // the choice is saved: a reload keeps it
      await admin.reload();
      await expect(admin.locator(`[data-admin-layout="${layout}"]`)).toHaveCount(1);
      await expect(admin.getByRole("heading", { name: "My account" })).toBeVisible();
      // the menu reaches another page (top navigation keeps items in section menus)
      if (layout === "topnav") {
        await admin.getByRole("button", { name: /Orders and customers/ }).click();
        await admin.getByRole("menuitem", { name: "Orders" }).click();
      } else {
        await admin.getByRole("link", { name: "Orders", exact: true }).first().click();
      }
      await expect(admin).toHaveURL(/\/admin\/orders$/);
      await admin.goto("/admin/account");
      await admin.getByTestId("appearance").waitFor();
    }
    expect(errors).toEqual([]);
  });

  test("quick find opens a page with the keyboard", async ({ admin }) => {
    await admin.goto("/admin");
    await admin.locator("[data-admin-layout]").waitFor(); // the shell (and its shortcut) is ready
    await admin.keyboard.press("Control+k");
    const dialog = admin.getByRole("dialog", { name: "Quick find" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Find a page" }).fill("coupons");
    await admin.keyboard.press("Enter");
    await expect(admin).toHaveURL(/\/admin\/coupons$/);
    await expect(dialog).toHaveCount(0);
  });
});
