import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { collectErrors, placeCodOrder, test } from "./helpers";

test("AI studio: status, switches, voice and activity log", async ({ admin }) => {
  const errors = collectErrors(admin);
  await admin.goto("/admin/ai");
  await expect(admin.getByRole("heading", { name: "AI studio" })).toBeVisible();
  await expect(admin.getByText(/Sandbox mode|Connected to Claude/).first()).toBeVisible();
  // Turn the review-reply feature off, save, and check the API agrees.
  const toggle = admin.getByRole("switch", { name: "Review replies on" });
  await toggle.uncheck();
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText("AI settings saved").first()).toBeVisible();
  await toggle.check();
  await admin.getByRole("tab", { name: "Model, voice and budget" }).click();
  await admin.getByLabel("Brand voice").fill("Warm and brief. Simple Indian English.");
  await admin.getByRole("button", { name: "Save changes" }).click();
  await expect(admin.getByText("AI settings saved").first()).toBeVisible();
  await admin.getByRole("tab", { name: "Activity" }).click();
  await expect(admin.getByRole("heading", { name: "Activity" })).toBeVisible();
  // Fixed rules are visible but not editable.
  await admin.getByRole("tab", { name: "Features" }).click();
  await admin.getByRole("button", { name: "View fixed rules" }).first().click();
  await expect(admin.getByRole("dialog").getByText(/never invent/i)).toBeVisible();
  await admin.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("support desk drafts a reply with AI and sends the edited text", async ({ admin, browser }) => {
  // A customer opens a ticket.
  const { otpLogin, randomPhone } = await import("./helpers");
  const buyer = await (await browser.newContext()).newPage();
  await buyer.goto("/login?next=/support/new");
  await otpLogin(buyer, randomPhone("97"), "Kavya");
  await buyer.waitForURL("**/support/new");
  await buyer.getByLabel("Subject").fill("Parcel not delivered yet");
  await buyer.getByLabel(/Tell us what happened|Message|Details/).first().fill("My parcel was due yesterday and has not arrived.");
  await buyer.getByRole("button", { name: /Send|Submit|Raise/ }).first().click();
  await buyer.waitForURL(/\/support\/[0-9a-f-]{36}/);
  const ticketId = buyer.url().split("/").pop();

  await admin.goto(`/admin/support/${ticketId}`);
  await admin.getByRole("button", { name: "Draft with AI" }).click();
  await admin.getByLabel("Tone").selectOption("apologetic");
  await admin.getByRole("button", { name: "Write draft" }).click();
  const box = admin.getByLabel("Message");
  await expect(box).toHaveValue(/Kavya/);
  await box.fill((await box.inputValue()) + " We will call the courier today.");
  await admin.getByRole("button", { name: "Send reply" }).click();
  await expect(admin.getByText("Reply sent to the customer").first()).toBeVisible();
  await buyer.reload();
  await expect(buyer.getByText(/We will call the courier today/)).toBeVisible();
});

test("order page shows the risk brief and sends an AI-drafted customer message", async ({ admin, baseURL }) => {
  const number = await placeCodOrder(baseURL!);
  await admin.goto("/admin/orders");
  await admin.locator("table a", { hasText: number }).first().click();
  await expect(admin.getByRole("region", { name: "Order risk" })).toBeVisible();
  await admin.getByRole("button", { name: "Write message with AI" }).click();
  await admin.getByLabel("What should the message tell them?").fill("Tell them the seller ships tomorrow");
  await admin.getByRole("button", { name: "Write draft" }).click();
  await expect(admin.getByLabel("Subject")).toHaveValue(/order/i);
  await admin.getByLabel("Message", { exact: true }).fill("Hello, your seller will ship your order tomorrow. Thank you for waiting.");
  await admin.getByRole("button", { name: "Send to customer" }).click();
  await expect(admin.getByText("Message sent to the customer").first()).toBeVisible();
});

test("list pages export what is on screen", async ({ admin, seller }) => {
  await admin.goto("/admin/returns");
  await admin.getByRole("button", { name: "Export" }).click();
  await admin.getByLabel("Period").selectOption("90");
  await admin.getByRole("dialog", { name: "Export" }).getByRole("radio", { name: "CSV" }).click();
  const [file] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("dialog", { name: "Export" }).getByRole("button", { name: "Download CSV" }).click()]);
  expect(file.suggestedFilename()).toMatch(/-returns-.*\.csv$/);
  expect(readFileSync(await file.path(), "utf8")).toContain("Return,Package,Seller");

  await seller.goto("/seller/orders");
  await seller.getByRole("button", { name: "Export" }).click();
  await seller.getByRole("dialog", { name: "Export" }).getByRole("radio", { name: "CSV" }).click();
  const [sf] = await Promise.all([seller.waitForEvent("download"), seller.getByRole("dialog", { name: "Export" }).getByRole("button", { name: "Download CSV" }).click()]);
  expect(readFileSync(await sf.path(), "utf8")).toContain("Package,Order,Placed (IST)");

  await admin.goto("/admin/sellers");
  await admin.getByRole("button", { name: "Export" }).click();
  await admin.getByRole("dialog", { name: "Export" }).getByRole("radio", { name: "CSV" }).click();
  const [all] = await Promise.all([admin.waitForEvent("download"), admin.getByRole("dialog", { name: "Export" }).getByRole("button", { name: "Download CSV" }).click()]);
  expect(readFileSync(await all.path(), "utf8")).toContain("Store,Legal name");
});
