import { describe, expect, it } from "vitest";
import { normalizeCliArgv } from "../src/lib/argv.js";

describe("normalizeCliArgv", () => {
	it("rewrites register create shorthand", () => {
		expect(
			normalizeCliArgv(["node", "tap", "register", "--name", "Smoke", "--description", "x"]),
		).toEqual(["node", "tap", "register", "create", "--name", "Smoke", "--description", "x"]);
	});

	it("keeps register update intact", () => {
		expect(normalizeCliArgv(["node", "tap", "register", "update", "--description", "x"])).toEqual([
			"node",
			"tap",
			"register",
			"update",
			"--description",
			"x",
		]);
	});

	it("keeps register help intact", () => {
		expect(normalizeCliArgv(["node", "tap", "register", "--help"])).toEqual([
			"node",
			"tap",
			"register",
			"--help",
		]);
	});

	it("rewrites bare register to create", () => {
		expect(normalizeCliArgv(["node", "tap", "register"])).toEqual([
			"node",
			"tap",
			"register",
			"create",
		]);
	});

	it("rewrites register shorthand after boolean global options", () => {
		expect(
			normalizeCliArgv(["node", "tap", "--json", "--verbose", "register", "--name", "Smoke"]),
		).toEqual(["node", "tap", "--json", "--verbose", "register", "create", "--name", "Smoke"]);
	});

	it("rewrites register shorthand after value-taking global options", () => {
		expect(
			normalizeCliArgv([
				"node",
				"tap",
				"--chain",
				"eip155:8453",
				"--data-dir=/tmp/tap",
				"register",
				"--name",
				"Smoke",
			]),
		).toEqual([
			"node",
			"tap",
			"--data-dir=/tmp/tap",
			"--chain",
			"eip155:8453",
			"register",
			"create",
			"--name",
			"Smoke",
		]);
	});

	it("hoists global output options even when they are placed after the command", () => {
		expect(normalizeCliArgv(["node", "tap", "contacts", "list", "--output", "json"])).toEqual([
			"node",
			"tap",
			"--output",
			"json",
			"contacts",
			"list",
		]);
	});

	it("rewrites command-local --describe into the schema command", () => {
		expect(normalizeCliArgv(["node", "tap", "contacts", "list", "--describe"])).toEqual([
			"node",
			"tap",
			"schema",
			"contacts",
			"list",
		]);
	});
});
