import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Offiziell LTX-2.5 Text / Bild zu Video",
    { timeout: 15_000 },
  );
});

test("a fresh editor is latest-first while explicit legacy projects remain selectable", async ({ page }) => {
  const modes = page.locator(".mode-button");
  await expect(modes.nth(0)).toContainText("LTX 2.5");
  await expect(modes.nth(1)).toContainText("DFR");
  await expect(modes.nth(2)).toContainText("LTX 2.5 T2A");
  await expect(modes.nth(3)).toContainText("LTX 2.3");
  await expect(page.getByText("LTX-2.5 · Split BF16", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Gesprochener Text" })).toBeVisible();
  await expect(page.getByRole("button", { name: "LTX-2.5 Split-Pack" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The hermetic browser fixture deliberately contains no 39-GiB production
  // model. Latest-first still selects the split contract, while discovery
  // correctly leaves unavailable model paths empty/fail-closed.
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "LTX-2.5 Transformer Pfad" })).toHaveValue("");
  await expect(page.getByLabel("Beim Start mit Gemma verbessern")).not.toBeChecked();

  const prompt = page.getByRole("textbox", { name: "Positive Beschreibung" });
  await prompt.fill("A stable close-up portrait with exact native dialogue.");
  await page.getByRole("button", { name: "LTX 2.3 Legacy · 8 + 3" }).click();
  await expect(page.getByText("LTX-2.3 · Monolith Legacy", { exact: true })).toBeVisible();
  await expect(prompt).toHaveValue("A stable close-up portrait with exact native dialogue.");

  await page.getByRole("button", { name: "LTX 2.5 Offiziell · 8 + 3" }).click();
  await expect(page.getByText("LTX-2.5 · Split BF16", { exact: true })).toBeVisible();
  await expect(prompt).toHaveValue("A stable close-up portrait with exact native dialogue.");
  await expect(page.getByLabel("Beim Start mit Gemma verbessern")).not.toBeChecked();
});
