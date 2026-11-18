import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

const API_LOG = process.env.API_LOG ?? "/tmp/api.log";

export function randomPhone(prefix = "98") {
  return prefix + String(Math.floor(10_000_000 + Math.random() * 89_999_999));
}

/** The console SMS provider writes "DEV OTP for <phone>: <code>" to the API log. */
export async function otpFor(phone: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const hits = [...readFileSync(API_LOG, "utf8").matchAll(new RegExp(`DEV OTP for ${phone}: (\\d+)`, "g"))];
    if (hits.length) return hits[hits.length - 1][1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No OTP for ${phone} in ${API_LOG}`);
}

/**
 * Signs in on the sign-in page the test is on. With a name, the number is new: it goes from the sign-in page
 * to Create account (the same "next" is kept), fills the form and verifies the code.
 */
export async function otpLogin(page: Page, phone: string, name?: string) {
  if (name) return createAccount(page, phone, name);
  const input = page.locator("input[type=tel]");
  const code = page.locator("input[autocomplete=one-time-code]");
  for (let attempt = 0; attempt < 3; attempt++) {
    // Fill again on every attempt: a fill that lands before the page hydrates is cleared by React.
    await input.fill(phone);
    await expect(input).toHaveValue(new RegExp(phone.slice(-4)));
    await page.getByRole("button", { name: "Send code" }).click();
    try {
      await expect(code).toBeVisible({ timeout: 5_000 });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      // A code sent less than 30 s ago blocks a new one; wait it out once.
      if (await page.getByText(/wait|seconds|too many/i).count()) await page.waitForTimeout(31_000);
    }
  }
  await code.fill(await otpFor(phone));
  await page.getByRole("button", { name: "Verify and continue" }).click();
}

export async function createAccount(page: Page, phone: string, name: string) {
  if (!page.url().includes("/signup")) await page.getByRole("link", { name: /Create (an account|your seller account)/ }).last().click();
  await page.waitForURL(/\/signup/);
  const nameBox = page.locator("input[autocomplete=name]");
  const code = page.locator("input[autocomplete=one-time-code]");
  for (let attempt = 0; attempt < 3; attempt++) {
    await nameBox.fill(name);
    await page.locator("input[type=tel]").fill(phone);
    await expect(nameBox).toHaveValue(name);
    const terms = page.getByRole("checkbox").first();
    if (!(await terms.isChecked())) await terms.check();
    await page.getByRole("button", { name: "Continue" }).click();
    try {
      await expect(code).toBeVisible({ timeout: 5_000 });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      if (await page.getByText(/wait|seconds|too many/i).count()) await page.waitForTimeout(31_000);
    }
  }
  await code.fill(await otpFor(phone));
  await page.getByRole("button", { name: "Verify and create account" }).click();
}

export async function adminLogin(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(process.env.ADMIN_EMAIL ?? "admin@pixcart.in");
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD ?? "PixCart@Admin2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/admin");
}

export function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

import { test as base, type Browser } from "@playwright/test";

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  return ctx.newPage();
}

/**
 * Signed-in pages shared by every test in a worker. Logging in once per role keeps the suite within the
 * API's sign-in rate limits (10 password attempts per 15 minutes, 5 OTPs per phone per hour) and avoids
 * replaying rotated refresh tokens across contexts.
 */
export const test = base.extend<object, { admin: Page; seller: Page }>({
  admin: [async ({ browser }, use) => {
    const page = await freshPage(browser);
    await adminLogin(page);
    await use(page);
    await page.context().close();
  }, { scope: "worker" }],
  seller: [async ({ browser }, use) => {
    const page = await freshPage(browser);
    await page.goto("/login?next=/seller");
    await otpLogin(page, process.env.SELLER_PHONE ?? "9000000001");
    await page.waitForURL("**/seller");
    await use(page);
    await page.context().close();
  }, { scope: "worker" }],
});
