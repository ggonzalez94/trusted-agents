import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10000,
	},
	resolve: {
		alias: {
			"@trustedagents/app-expenses": path.resolve(
				import.meta.dirname,
				"../app-expenses/src/index.ts",
			),
		},
	},
});
