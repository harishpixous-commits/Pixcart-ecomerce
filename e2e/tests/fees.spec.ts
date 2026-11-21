import { expect, type Page } from "@playwright/test";
import { collectErrors, otpLogin, randomPhone, test } from "./helpers";

const PRODUCT = "/p/men-s-pure-cotton-slim-fit-casual-shirt";

/** Admin → Checkout and fees: switch the bad weather and late night fees off again. */
async function switchOff(admin: Page) {
  await admin.goto("/admin/checkout");
  await admin.getByTestId("checkout-settings").waitFor();
  for (const id of ["toggle-surge_enabled", "toggle-late_night_enabled"]) {
    const box = admin.getByTestId(id);
    if (await box.isChecked()) await box.uncheck();
  }
  if (await admin.getByText("Unsaved changes").count()) {
    await admin.getByTestId("save-checkout").click();
    await expect(admin.getByText(/Checkout and fees saved/).first()).toBeVisible();
  }
}

test.describe.serial("time-bound fees: the owner switches a rain fee on, shoppers see it on the bill", () => {
  let shopper: Page;

  test.afterAll(async ({ admin }) => {
    await switchOff(admin);
    await shopper?.context().close();
  });

  test("admin turns on a rain fee for an hour and tries the late night fee in the preview", async ({ admin }) => {
    const errors = collectErrors(admin);
    await admin.goto("/admin/checkout");
    await admin.getByTestId("checkout-settings").waitFor();

    // the late night fee, seen in the preview only (not saved)
    await admin.getByTestId("toggle-late_night_enabled").check();
    await admin.getByTestId("amount-late_night_paise").fill("15");
    await admin.getByTestId("preview-night").check();
    const preview = admin.getByTestId("checkout-preview");
    await expect(preview.getByTestId("fee-late_night")).toContainText("₹15");
    await expect(preview.getByText("On orders placed between 11 pm and 6 am")).toBeVisible();
    await admin.getByTestId("toggle-late_night_enabled").uncheck();

    // the bad weather fee, renamed "Rain fee", for one hour
    await admin.getByTestId("toggle-surge_enabled").check();
    await admin.getByTestId("amount-surge_paise").fill("25");
    await admin.getByTestId("surge-for").selectOption("1");
    await admin.locator("section", { hasText: "Bad weather fee" }).first().getByLabel("Name").fill("Rain fee");
    await expect(preview.getByTestId("fee-surge")).toContainText("Rain fee");
    await admin.getByTestId("save-checkout").click();
    await expect(admin.getByText(/Checkout and fees saved\. The rain fee stops at/).first()).toBeVisible();
    await expect(admin.getByTestId("surge-status")).toContainText("Being charged now, until");
    expect(errors).toEqual([]);
  });

  test("a shopper on a phone sees the rain fee on the bill with its explanation", async ({ browser }) => {
    shopper = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const errors = collectErrors(shopper);
    await shopper.goto("/login");
    await otpLogin(shopper, randomPhone("97"), "Rain Shopper");
    await shopper.waitForURL((u) => !u.pathname.startsWith("/login") && !u.pathname.startsWith("/signup"));
    await shopper.goto(PRODUCT);
    await shopper.getByRole("button", { name: "Add to cart" }).first().click();
    await expect(shopper.getByText("Added to your cart").first()).toBeVisible();
    await shopper.goto("/cart");
    const fee = shopper.getByTestId("fee-surge");
    await expect(fee).toContainText("Rain fee");
    await expect(fee).toContainText("₹25");
    await fee.getByRole("button", { name: /Rain fee/ }).click();
    await expect(shopper.getByText(/Charged during heavy rain or very high demand/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("switched off, the fee leaves the shopper's bill", async ({ admin }) => {
    await switchOff(admin);
    await expect(admin.getByTestId("surge-status")).toHaveCount(0);
    await shopper.goto("/cart");
    await expect(shopper.getByTestId("bill")).toBeVisible();
    await expect(shopper.getByTestId("fee-surge")).toHaveCount(0);
  });
});
