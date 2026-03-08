import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";

describe("message command flags", () => {
	it("documents the unsafe action approval flag and removes yes-actions", () => {
		const program = createCli();
		const message = program.commands.find((command) => command.name() === "message");
		const listen = message?.commands.find((command) => command.name() === "listen");
		const help = listen?.helpInformation() ?? "";

		expect(help).toContain("--unsafe-approve-actions");
		expect(help).not.toContain("--yes-actions");
	});
});
