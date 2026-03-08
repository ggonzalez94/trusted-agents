#!/usr/bin/env node
import { createCli } from "./cli.js";
import { normalizeCliArgv } from "./lib/argv.js";

const program = createCli();
program.parseAsync(normalizeCliArgv(process.argv)).catch((err: Error & { code?: string }) => {
	// Commander throws for --help and --version with exitOverride
	if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
		process.exit(0);
	}
	// Usage errors (missing args, unknown options)
	if (
		err.code === "commander.missingArgument" ||
		err.code === "commander.unknownOption" ||
		err.code === "commander.missingMandatoryOptionValue"
	) {
		process.exit(2);
	}
	process.exit(1);
});
