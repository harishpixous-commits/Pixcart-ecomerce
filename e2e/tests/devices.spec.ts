import { expect } from "@playwright/test";
import { collectErrors, otpLogin, randomPhone, test } from "./helpers";

/*
 * Signed-in devices: a shopper signed in on a phone and a computer sees both on the Account page, signs the phone
 * out from the computer, and the phone is sent to sign in again while the computer carries on.
 */

test("a shopper signs out their other device from the Account page", async ({ browser }) => {
  test.setTimeout(120_000);
  const phoneNo = randomPhone("96");
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36" })).newPage();
  await phone.goto("/login?next=/account");
  await otpLogin(phone, phoneNo, "Two Devices");
  await phone.waitForURL((u) => u.pathname === "/account");

  const computer = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  const errors = collectErrors(computer);
  await computer.goto("/login?next=/account");
  await otpLogin(computer, phoneNo); // waits out the 30 s before a second code
  await computer.waitForURL((u) => u.pathname === "/account");

  const card = computer.getByTestId("signed-in-devices");
  await expect(card.getByRole("listitem")).toHaveCount(2);
  await expect(card.getByText("Chrome on Android")).toBeVisible();
  await expect(card.getByText("This device")).toHaveCount(1);
  await card.getByTestId("sign-out-others").click();
  await computer.getByTestId("sign-out-others-confirm").click();
  await expect(computer.getByText("1 other device was signed out")).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(1);

  // the computer keeps working
  await computer.reload();
  await expect(computer.getByTestId("signed-in-devices")).toBeVisible();
  expect(errors).toEqual([]);

  // the phone must sign in again
  await phone.goto("/account");
  await phone.waitForURL(/\/login/);
});
