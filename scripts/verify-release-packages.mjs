import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

const packages = [
	{ dir: "packages/core", name: "trusted-agents-core" },
	{ dir: "packages/tapd", name: "trusted-agents-tapd" },
	{ dir: "packages/sdk", name: "trusted-agents-sdk" },
	{ dir: "packages/cli", name: "trusted-agents-cli" },
	{ dir: "packages/openclaw-plugin", name: "trusted-agents-tap" },
];

const errors = [];

for (const pkg of packages) {
	const packageDir = join(rootDir, pkg.dir);
	const packageJsonPath = join(packageDir, "package.json");
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const packedPackageDir = packPackage(packageDir, pkg.name);

	assertPath(packageDir, `${pkg.name} README`, "README.md");
	assertPath(packageDir, `${pkg.name} main`, manifest.main);
	assertPath(packageDir, `${pkg.name} types`, manifest.types);
	assertPath(packedPackageDir, `${pkg.name} packed README`, "README.md");
	assertPath(packedPackageDir, `${pkg.name} packed main`, manifest.main);
	assertPath(packedPackageDir, `${pkg.name} packed types`, manifest.types);

	if (manifest.bin && typeof manifest.bin === "object") {
		for (const [binName, binPath] of Object.entries(manifest.bin)) {
			assertPath(packageDir, `${pkg.name} bin:${binName}`, binPath);
			assertPath(packedPackageDir, `${pkg.name} packed bin:${binName}`, binPath);
		}
	}

	if (manifest.exports && typeof manifest.exports === "object") {
		for (const [exportName, exportValue] of Object.entries(manifest.exports)) {
			assertExports(packageDir, `${pkg.name} export:${exportName}`, exportValue);
			assertExports(packedPackageDir, `${pkg.name} packed export:${exportName}`, exportValue);
		}
	}

	if (Array.isArray(manifest.files)) {
		for (const entry of manifest.files) {
			assertPath(packageDir, `${pkg.name} files:${entry}`, entry);
		}
	}

	assertNoWorkspaceDependencies(pkg.name, packedPackageDir);
	assertOpenClawExtensions(pkg.name, packedPackageDir);
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

function assertNoWorkspaceDependencies(packageName, packedPackageDir) {
	const packageJsonPath = join(packedPackageDir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return;
	}

	const packedManifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		const dependencies = packedManifest[field];
		if (!dependencies || typeof dependencies !== "object") {
			continue;
		}

		for (const [dependency, version] of Object.entries(dependencies)) {
			if (typeof version === "string" && version.startsWith("workspace:")) {
				errors.push(`${packageName} packed ${field}.${dependency} must not use workspace protocol`);
			}
		}
	}
}

function packPackage(packageDir, packageName) {
	const packRoot = mkdtempSync(join(tmpdir(), "trusted-agents-pack-"));

	try {
		const tarballOutput = execFileSync(
			"bun",
			["pm", "pack", "--destination", packRoot, "--quiet", "--ignore-scripts"],
			{
				cwd: packageDir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
			.trim()
			.split("\n")
			.pop();

		if (!tarballOutput) {
			errors.push(`${packageName} bun pm pack did not report a tarball name`);
			return packRoot;
		}

		const tarballPath = tarballOutput.startsWith("/")
			? tarballOutput
			: join(packRoot, tarballOutput);

		execFileSync("tar", ["-xzf", tarballPath, "-C", packRoot], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		return join(packRoot, "package");
	} catch (error) {
		errors.push(
			`${packageName} could not be packed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return packRoot;
	} finally {
		process.on("exit", () => {
			rmSync(packRoot, { recursive: true, force: true });
		});
	}
}

function assertOpenClawExtensions(packageName, packedPackageDir) {
	const packageJsonPath = join(packedPackageDir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return;
	}

	const packedManifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const extensions = packedManifest.openclaw?.extensions;

	if (!Array.isArray(extensions)) {
		return;
	}

	for (const [index, entry] of extensions.entries()) {
		assertPath(packedPackageDir, `${packageName} packed openclaw.extensions[${index}]`, entry);
		if (!entry.startsWith("./dist/") || !entry.endsWith(".js")) {
			errors.push(
				`${packageName} openclaw.extensions[${index}] must point at a built JS entry under dist/, got ${entry}`,
			);
		}
	}

	if (existsSync(join(packedPackageDir, "index.ts"))) {
		errors.push(`${packageName} packed tarball should not ship a root source entrypoint index.ts`);
	}
}
