const GLOBAL_OPTIONS_WITH_VALUE = new Set(["--config", "--data-dir", "--chain", "--rpc-url"]);
const GLOBAL_OPTIONS = new Set([
	"--json",
	"--plain",
	"--verbose",
	"-v",
	"--quiet",
	"-q",
	"--help",
	"-h",
	"--version",
	"-V",
]);

function findRegisterCommandIndex(argv: string[]): number | undefined {
	for (let index = 2; index < argv.length; ) {
		const token = argv[index];
		if (!token || token === "--") {
			return undefined;
		}

		if (token === "register") {
			return index;
		}

		if (!token.startsWith("-")) {
			return undefined;
		}

		const [optionName] = token.split("=", 1);
		if (optionName && GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
			index += token.includes("=") ? 1 : 2;
			continue;
		}

		if (GLOBAL_OPTIONS.has(token)) {
			index += 1;
			continue;
		}

		return undefined;
	}

	return undefined;
}

export function normalizeCliArgv(argv: string[]): string[] {
	const registerIndex = findRegisterCommandIndex(argv);
	if (registerIndex === undefined) {
		return argv;
	}

	const next = argv[registerIndex + 1];
	if (!next || next === "create" || next === "update" || next === "--help" || next === "-h") {
		return next
			? argv
			: [...argv.slice(0, registerIndex + 1), "create", ...argv.slice(registerIndex + 1)];
	}

	if (next.startsWith("-")) {
		return [...argv.slice(0, registerIndex + 1), "create", ...argv.slice(registerIndex + 1)];
	}

	return argv;
}
