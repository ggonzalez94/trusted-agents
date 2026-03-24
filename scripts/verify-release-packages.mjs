import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

const packages = [
	{ dir: "packages/core", name: "trusted-agents-core" },
	{ dir: "packages/cli", name: "trusted-agents-cli" },
	{ dir: "packages/openclaw-plugin", name: "trusted-agents-tap" },
];

const errors = [];

for (const pkg of packages) {
	const packageDir = join(rootDir, pkg.dir);
	const packageJsonPath = join(packageDir, "package.json");
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));

	assertPath(packageDir, `${pkg.name} README`, "README.md");
	assertPath(packageDir, `${pkg.name} main`, manifest.main);
	assertPath(packageDir, `${pkg.name} types`, manifest.types);

	if (manifest.bin && typeof manifest.bin === "object") {
		for (const [binName, binPath] of Object.entries(manifest.bin)) {
			assertPath(packageDir, `${pkg.name} bin:${binName}`, binPath);
		}
	}

	if (manifest.exports && typeof manifest.exports === "object") {
		for (const [exportName, exportValue] of Object.entries(manifest.exports)) {
			assertExports(packageDir, `${pkg.name} export:${exportName}`, exportValue);
		}
	}

	if (Array.isArray(manifest.files)) {
		for (const entry of manifest.files) {
			assertPath(packageDir, `${pkg.name} files:${entry}`, entry);
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`ERROR: ${error}`);
	}
	process.exit(1);
}

console.log("Release package verification passed.");

function assertExports(packageDir, label, value) {
	if (typeof value === "string") {
		assertPath(packageDir, label, value);
		return;
	}

	if (!value || typeof value !== "object") {
		errors.push(`${label} has unsupported exports shape`);
		return;
	}

	for (const [condition, target] of Object.entries(value)) {
		if (typeof target === "string") {
			assertPath(packageDir, `${label}:${condition}`, target);
		}
	}
}

function assertPath(packageDir, label, relativePath) {
	if (typeof relativePath !== "string" || relativePath.length === 0) {
		errors.push(`${label} is missing`);
		return;
	}

	const target = join(packageDir, relativePath);
	if (!existsSync(target)) {
		errors.push(`${label} points to missing path ${relativePath}`);
		return;
	}

	try {
		statSync(target);
	} catch (error) {
		errors.push(
			`${label} could not be read at ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
