import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./", import.meta.url)),
		},
	},
	esbuild: {
		// Enable the React 17+ automatic JSX runtime for .tsx test files so
		// components that do not explicitly `import React` still render.
		jsx: "automatic",
	},
	test: {
		include: ["test/unit/**/*.test.ts", "test/unit/**/*.test.tsx"],
		environment: "jsdom",
		testTimeout: 10000,
	},
});
