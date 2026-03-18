import { describe, expect, it } from "vitest";
import { createCli } from "../src/cli.js";

describe("message command flags", () => {
	it("does not expose deprecated unsafe action approval flags", () => {
		const program = createCli();
		const message = program.commands.find((command) => command.name() === "message");
		const listen = message?.commands.find((command) => command.name() === "listen");
		const help = listen?.helpInformation() ?? "";

		expect(help).not.toContain("--unsafe-approve-actions");
		expect(help).not.toContain("--yes-actions");
	});
});
