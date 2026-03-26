import type { GlobalOptions } from "../types.js";

const GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"--config",
	"--data-dir",
	"--chain",
	"--rpc-url",
	"--output",
	"--select",
	"--fields",
	"--limit",
	"--offset",
]);

const HOISTED_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"--config",
	"--data-dir",
	"--rpc-url",
	"--output",
	"--select",
	"--fields",
	"--limit",
	"--offset",
]);

const GLOBAL_OPTIONS = new Set([
	"--json",
	"--plain",
	"--verbose",
	"-v",
	"--quiet",
	"-q",
	"--describe",
	"-D",
]);

const PASS_THROUGH_GLOBAL_OPTIONS = new Set(["--help", "-h", "--version", "-V"]);

function rewriteDescribe(argv: string[]): string[] {
	const describeIndex = argv.findIndex(
		(token, index) => index >= 2 && (token === "--describe" || token === "-D"),
	);
	if (describeIndex === -1) {
		return argv;
	}

	const withoutDescribe = argv.filter((_, index) => index !== describeIndex);
	const commandPath: string[] = [];
	let cursor = 2;
	while (cursor < withoutDescribe.length) {
		const token = withoutDescribe[cursor];
		if (!token || token === "--" || token.startsWith("-")) {
			break;
		}
		commandPath.push(token);
		cursor += 1;
	}

	return [
		...withoutDescribe.slice(0, 2),
		"schema",
		...commandPath,
		...withoutDescribe.slice(2 + commandPath.length),
	];
}

function hoistGlobalOptions(argv: string[]): string[] {
	const prefix = argv.slice(0, 2);
	const globals: string[] = [];
	const rest: string[] = [];

	for (let index = 2; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token) {
			continue;
		}

		if (token === "--") {
			rest.push(...argv.slice(index));
			break;
		}

		const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (GLOBAL_OPTIONS.has(token)) {
			globals.push(token);
			continue;
		}

		if (optionName && HOISTED_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
			globals.push(token);
			if (!token.includes("=") && index + 1 < argv.length) {
				globals.push(argv[index + 1]!);
				index += 1;
			}
			continue;
		}

		rest.push(token);
	}

	return [...prefix, ...globals, ...rest];
}

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

		const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (optionName && GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
			index += token.includes("=") ? 1 : 2;
			continue;
		}

		if (GLOBAL_OPTIONS.has(token) || PASS_THROUGH_GLOBAL_OPTIONS.has(token)) {
			index += 1;
			continue;
		}

		return undefined;
	}

	return undefined;
}

export function normalizeCliArgv(argv: string[]): string[] {
	const rewrittenDescribe = rewriteDescribe(argv);
	const hoistedGlobals = hoistGlobalOptions(rewrittenDescribe);
	const registerIndex = findRegisterCommandIndex(hoistedGlobals);
	if (registerIndex === undefined) {
		return hoistedGlobals;
	}

	const next = hoistedGlobals[registerIndex + 1];
	if (!next || next === "create" || next === "update" || next === "--help" || next === "-h") {
		return next
			? hoistedGlobals
			: [
					...hoistedGlobals.slice(0, registerIndex + 1),
					"create",
					...hoistedGlobals.slice(registerIndex + 1),
				];
	}

	if (next.startsWith("-")) {
		return [
			...hoistedGlobals.slice(0, registerIndex + 1),
			"create",
			...hoistedGlobals.slice(registerIndex + 1),
		];
	}

	return hoistedGlobals;
}

export function readGlobalOptionsFromArgv(argv: string[]): Partial<GlobalOptions> {
	const normalized = normalizeCliArgv(argv);
	const options: Partial<GlobalOptions> = {};

	for (let index = 2; index < normalized.length; index += 1) {
		const token = normalized[index];
		if (!token || token === "--" || !token.startsWith("-")) {
			break;
		}

		const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		const inlineValue = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
		const nextValue = inlineValue ?? normalized[index + 1];

		switch (optionName) {
			case "--json":
				options.json = true;
				break;
			case "--plain":
				options.plain = true;
				break;
			case "--verbose":
			case "-v":
				options.verbose = true;
				break;
			case "--quiet":
			case "-q":
				options.quiet = true;
				break;
			case "--output":
				options.output = nextValue as GlobalOptions["output"];
				if (!token.includes("=")) index += 1;
				break;
			case "--config":
				options.config = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--data-dir":
				options.dataDir = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--rpc-url":
				options.rpcUrl = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--select":
				options.select = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--fields":
				options.fields = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--limit":
				options.limit = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			case "--offset":
				options.offset = nextValue;
				if (!token.includes("=")) index += 1;
				break;
			default:
				break;
		}
	}

	return options;
}
