import { describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli.js";

describe("tap schema", () => {
	it("describes the full command tree as machine-readable JSON", async () => {
		const result = await runCli(["schema"]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout) as {
			status: string;
			data: {
				name: string;
				subcommands: Array<{ name: string; subcommands?: Array<{ name: string }> }>;
			};
		};
		expect(output.status).toBe("ok");
		expect(output.data.name).toBe("tap");
		expect(output.data.subcommands.some((command) => command.name === "contacts")).toBe(true);
		expect(
			output.data.subcommands
				.find((command) => command.name === "contacts")
				?.subcommands?.some((command) => command.name === "list"),
		).toBe(true);
	});

	it("rewrites --describe on a command to schema output for that command", async () => {
		const result = await runCli(["contacts", "list", "--describe"]);

		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout) as {
			status: string;
			data: {
				path: string;
				examples?: string[];
				options: Array<{ name: string }>;
			};
		};
		expect(output.status).toBe("ok");
		expect(output.data.path).toBe("tap contacts list");
		expect(output.data.examples?.length).toBeGreaterThan(0);
		expect(output.data.options.some((option) => option.name === "output")).toBe(true);
	});
});
