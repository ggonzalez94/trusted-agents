import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./test/e2e",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "line",
	timeout: 30_000,
	use: {
		headless: true,
	},
});
