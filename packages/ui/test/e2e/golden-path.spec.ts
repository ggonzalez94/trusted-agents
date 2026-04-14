import { expect, test } from "@playwright/test";
import { type SeededTapd, seedTapd } from "./fixtures/seed-tapd.js";

let tapd: SeededTapd;

test.beforeAll(async () => {
	tapd = await seedTapd();
});

test.afterAll(async () => {
	if (tapd) {
		await tapd.cleanup();
	}
});

test("loads the dashboard with seeded identity and contact", async ({
	page,
}) => {
	await page.goto(`${tapd.url}/#token=${tapd.token}`);
	// The sidebar shows the operator identity.
	await expect(page.getByText("Alice", { exact: true })).toBeVisible();
	// The seeded contact appears in the DM list.
	await expect(page.getByText("Bob", { exact: true }).first()).toBeVisible();
});

test("clicking the contact opens the thread with seeded messages", async ({
	page,
}) => {
	await page.goto(`${tapd.url}/#token=${tapd.token}`);
	// Auto-selects the only active contact, but explicitly click to be safe.
	await page.getByText("Bob", { exact: true }).first().click();
	await expect(
		page.getByText(/thanks for connecting\. My operator/i),
	).toBeVisible();
	await expect(page.getByText(/sending \$10 now/)).toBeVisible();
});

test("composer renders the read-only placeholder", async ({ page }) => {
	await page.goto(`${tapd.url}/#token=${tapd.token}`);
	await page.getByText("Bob", { exact: true }).first().click();
	await expect(page.getByText(/Your agent speaks here/)).toBeVisible();
});
