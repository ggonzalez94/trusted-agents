export function normalizeCliArgv(argv: string[]): string[] {
	if (argv.length < 3 || argv[2] !== "register") {
		return argv;
	}

	const next = argv[3];
	if (!next || next === "create" || next === "update" || next === "--help" || next === "-h") {
		return next ? argv : [...argv.slice(0, 3), "create", ...argv.slice(3)];
	}

	if (next.startsWith("-")) {
		return [...argv.slice(0, 3), "create", ...argv.slice(3)];
	}

	return argv;
}
