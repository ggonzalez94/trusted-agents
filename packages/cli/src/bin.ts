#!/usr/bin/env node
import { createCli } from "./cli.js";
import { normalizeCliArgv, readGlobalOptionsFromArgv } from "./lib/argv.js";
import { exitCodeForError } from "./lib/errors.js";
import { error } from "./lib/output.js";

const program = createCli();
const argv = normalizeCliArgv(process.argv);

program.parseAsync(argv).catch((err: Error & { code?: string }) => {
	// Commander throws for --help and --version with exitOverride
	if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
		process.exit(0);
	}
	// Usage errors (missing args, unknown options)
	if (
		err.code === "commander.unknownCommand" ||
		err.code === "commander.missingArgument" ||
		err.code === "commander.unknownOption" ||
		err.code === "commander.missingMandatoryOptionValue"
	) {
		error("USAGE_ERROR", stripCommanderPrefix(err.message), readGlobalOptionsFromArgv(argv));
		process.exit(2);
	}
	error("UNEXPECTED_ERROR", stripCommanderPrefix(err.message), readGlobalOptionsFromArgv(argv));
	process.exit(exitCodeForError(err));
});

function stripCommanderPrefix(message: string): string {
	return message.replace(/^error:\s*/i, "");
}
