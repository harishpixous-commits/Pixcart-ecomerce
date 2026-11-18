import { expect } from "@playwright/test";
import { collectErrors, otpLogin, randomPhone, test } from "./helpers";

const PRODUCT = process.env.PRODUCT_PATH ?? "/p/non-stick-cookware-set-of-3-induction-base";

test("customer pays online through Razorpay checkout (simulator) and the order is placed", async ({ browser }) => {
  test.skip(!process.env.RAZORPAY_SIM, "Set RAZORPAY_SIM=1 when the API points at tools/razorpay-sim");
  const page = await (await browser.newContext()).newPage();
  const errors = collectErrors(page);
  await page.goto(PRODUCT);
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await expect(page.getByText("Added to your cart").first()).toBeVisible();
  await page.goto("/cart");
  await page.getByText("Sign in to place order").click();
  const phone = randomPhone("93");
  await otpLogin(page, phone, "Online Buyer");
  await page.waitForURL("**/checkout");
  await page.getByLabel("Full name").fill("Online Buyer");
  await page.locator("input[autocomplete=tel-national]").fill(phone);
  await page.locator("input[autocomplete=address-line1]").fill("5 Lake View Road");
  await page.locator("input[autocomplete=postal-code]").fill("600028");
  await page.locator("input[autocomplete=address-level2]").fill("Chennai");
  await page.getByRole("button", { name: "Save address" }).click();
  await page.getByText("Pay online").click();
  await page.getByRole("button", { name: /^Pay ₹/ }).click();
  const dialog = page.getByRole("dialog", { name: "Razorpay test payment" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /succeeds/ }).click();
  await expect(page.getByText("Package 1 of 1").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Paid|Online/i).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("admin assistant answers with live figures, keeps history and offers downloads", async ({ admin }) => {
  const errors = collectErrors(admin);
  await admin.goto("/admin");
  await admin.getByRole("button", { name: /Open the AI assistant/ }).click();
  const panel = admin.getByRole("region", { name: "AI assistant" }).or(admin.locator("section[aria-label='AI assistant']"));
  await expect(panel.getByText(/Ask about sales, orders, stock/)).toBeVisible();
  await panel.getByRole("button", { name: "New chat" }).click();
  await panel.getByLabel("Message").fill("How much did we sell this month?");
  await panel.getByLabel("Message").press("Enter");
  await expect(panel.getByText(/so far/).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Sales", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Orders", { exact: true }).first()).toBeVisible();
  // a second question in the same chat, then the history list shows it
  await panel.getByLabel("Message").fill("what needs my attention right now?");
  await panel.getByLabel("Message").press("Enter");
  await expect(panel.getByText("Waiting for you").first()).toBeVisible({ timeout: 30_000 });
  const dl = admin.waitForEvent("download");
  await panel.getByRole("button", { name: "Download this answer" }).last().click();
  await panel.getByRole("button", { name: "PDF" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.pdf$/);
  await panel.getByRole("button", { name: "Chat history" }).click();
  await expect(panel.getByRole("button", { name: /How much did we sell this month/ }).first()).toBeVisible();
  await panel.getByRole("button", { name: "Chat history" }).click();
  await expect(panel.getByRole("button", { name: "Voice mode" })).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();
  expect(errors).toEqual([]);
});

test("export center: Excel, PDF and several reports as one ZIP", async ({ admin }) => {
  const errors = collectErrors(admin);
  await admin.goto("/admin/exports");
  const orders = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Orders (one row per package)" }) });
  await orders.getByRole("radio", { name: "PDF" }).click();
  let dl = admin.waitForEvent("download");
  await orders.getByRole("button", { name: "Download PDF" }).click();
  expect((await dl).suggestedFilename()).toMatch(/orders-.*\.pdf$/);
  await orders.getByLabel("Select Orders (one row per package) for bulk download").check();
  const catalogue = admin.locator("section").filter({ has: admin.getByRole("heading", { name: "Catalogue" }) });
  await catalogue.getByLabel("Select Catalogue for bulk download").check();
  const bar = admin.getByRole("region", { name: "Bulk download" });
  await expect(bar.getByText("2 selected")).toBeVisible();
  dl = admin.waitForEvent("download");
  await bar.getByRole("button", { name: "Download ZIP" }).click();
  expect((await dl).suggestedFilename()).toMatch(/reports-.*\.zip$/);
  expect(errors).toEqual([]);
});

test("integrations, roles, AI providers, assistant settings and go-live pages work", async ({ admin }) => {
  const errors = collectErrors(admin);
  await admin.goto("/admin/integrations");
  await expect(admin.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await admin.getByRole("button", { name: /Razorpay payments/ }).click();
  const dlg = admin.getByRole("dialog", { name: "Razorpay payments" });
  await expect(dlg.getByText("Webhook address")).toBeVisible();
  await dlg.getByRole("button", { name: "Test with saved settings" }).click();
  await expect(dlg.getByRole("status")).toBeVisible({ timeout: 20_000 });
  await admin.keyboard.press("Escape");

  await admin.goto("/admin/staff");
  await admin.getByRole("tab", { name: /Roles/ }).click();
  await admin.getByRole("button", { name: "New role" }).click();
  const roleName = `Night shift ${Date.now() % 100000}`;
  await admin.getByLabel("Role name").fill(roleName);
  await admin.getByRole("dialog").getByText("Orders and returns", { exact: true }).click();
  await admin.getByRole("button", { name: "Create role" }).click();
  await expect(admin.getByRole("button", { name: roleName })).toBeVisible();

  await admin.goto("/admin/ai-providers");
  await expect(admin.getByRole("heading", { name: "AI providers" })).toBeVisible();
  await expect(admin.getByText("Which model answers, and the fallbacks")).toBeVisible();

  await admin.goto("/admin/assistant");
  await admin.getByRole("button", { name: "Try" }).click();
  await expect(admin.getByText(/"period": "today"/)).toBeVisible();

  await admin.goto("/admin/go-live");
  await expect(admin.getByRole("heading", { name: "Go-live checklist" })).toBeVisible();
  await expect(admin.getByText("2. Payments")).toBeVisible();
  expect(errors).toEqual([]);
});
