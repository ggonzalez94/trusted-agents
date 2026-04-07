#!/usr/bin/env node

const version = process.argv[2]?.trim();

if (!version) {
	console.error("Usage: node scripts/release-channel.mjs <version>");
	process.exit(1);
}

const isPrerelease = version.includes("-");

process.stdout.write(
	`${JSON.stringify({
		version,
		isPrerelease,
		npmDistTag: isPrerelease ? "beta" : null,
	})}\n`,
);
