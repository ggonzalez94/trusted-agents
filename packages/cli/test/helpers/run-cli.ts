import { createCli } from "../../src/cli.js";

export interface CliRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export async function runCli(args: string[]): Promise<CliRunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const origStdoutWrite = process.stdout.write;
	const origStderrWrite = process.stderr.write;
	const origExitCode = process.exitCode;

	process.exitCode = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;

	try {
		const program = createCli();
		await program.parseAsync(args, { from: "user" });
	} catch (error) {
		const err = error as Error & { code?: string };
		if (
			err.code !== "commander.helpDisplayed" &&
			err.code !== "commander.version" &&
			err.code !== "commander.missingArgument" &&
			err.code !== "commander.unknownOption" &&
			err.code !== "commander.missingMandatoryOptionValue"
		) {
			throw error;
		}
		if (process.exitCode === undefined || process.exitCode === 0) {
			process.exitCode = 2;
		}
	} finally {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
	}

	const exitCode = process.exitCode ?? 0;
	process.exitCode = origExitCode;
	return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}
