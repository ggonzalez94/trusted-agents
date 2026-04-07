# Prerelease Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stable-by-default prerelease support across the TAP npm release flow, shell installer, `tap install`, and user-facing docs.

**Architecture:** Keep prerelease behavior explicit and opt-in. The release workflow will continue triggering from `v*` tags but will route prerelease versions to the npm `beta` dist-tag. The shell installer and `tap install` will accept `--channel` and `--version`, with `--version` taking precedence, and pass the selected package spec all the way through to the OpenClaw plugin install path.

**Tech Stack:** GitHub Actions YAML, Bash, TypeScript (ESM, `.js` imports), Vitest, Biome, Bun

**Spec:** `docs/superpowers/specs/2026-04-07-prerelease-support-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/test/install.test.ts` | Add red/green coverage for `tap install --channel/--version` and OpenClaw plugin package selection |
| `packages/cli/test/install-script.test.ts` | Add shell-installer coverage with fake `node`, `npm`, and `npx` binaries |
| `packages/cli/test/release-channel.test.ts` | Verify release-channel detection for stable vs prerelease versions |
| `packages/cli/src/cli.ts` | Expose `tap install --channel` and `tap install --version` |
| `packages/cli/src/commands/install.ts` | Parse selectors, choose plugin package spec, and surface notes |
| `packages/cli/src/lib/command-metadata.ts` | Update `tap install` examples |
| `scripts/install.sh` | Add argument parsing, usage text, package-spec selection, and selector passthrough to `tap install` |
| `scripts/release-channel.mjs` | Small helper that resolves stable vs prerelease npm publish behavior from a tag version |
| `.github/workflows/release.yml` | Use the helper to publish stable to `latest` and prereleases to `beta` |
| `README.md` | Document default stable install and prerelease opt-in |
| `docs/release.md` | Document prerelease tag format and npm dist-tag behavior |
| `skills/trusted-agents/SKILL.md` | Document `tap install --channel` and `tap install --version` |

---

### Task 1: Add failing tests for prerelease-selection behavior

**Files:**
- Modify: `packages/cli/test/install.test.ts`
- Create: `packages/cli/test/install-script.test.ts`
- Create: `packages/cli/test/release-channel.test.ts`

- [ ] **Step 1: Extend `tap install` tests with channel/version expectations**

Add failing tests that verify:

- `tap install --channel beta --runtime openclaw` invokes `openclaw plugins install trusted-agents-tap@beta`
- `tap install --version 0.2.0-beta.1 --runtime openclaw` invokes `openclaw plugins install trusted-agents-tap@0.2.0-beta.1`
- when both are provided, `--version` wins

- [ ] **Step 2: Add shell-installer tests that exercise argument parsing**

Create `packages/cli/test/install-script.test.ts` with a fake PATH containing `node`, `npm`, and `npx` shims. Add failing tests that verify:

- default install uses `npm i -g trusted-agents-cli`
- `--channel beta` uses `npm i -g trusted-agents-cli@beta`
- `--version 0.2.0-beta.1` uses `npm i -g trusted-agents-cli@0.2.0-beta.1`
- selector passthrough calls `npx trusted-agents-cli install --channel beta` or `--version 0.2.0-beta.1`
- `--version` wins over `--channel`

- [ ] **Step 3: Add release-channel helper tests**

Create `packages/cli/test/release-channel.test.ts` with cases for:

- `0.1.5` -> stable, no publish tag
- `0.2.0-beta.1` -> prerelease, `beta`
- `0.2.0-rc.1` -> prerelease, `beta`

The test should execute `node scripts/release-channel.mjs <version>` and assert the JSON output.

- [ ] **Step 4: Run the new focused tests and confirm they fail for the expected reason**

Run:

```bash
bun vitest run packages/cli/test/install.test.ts packages/cli/test/install-script.test.ts packages/cli/test/release-channel.test.ts
```

Expected: failures indicating missing CLI options, missing installer parsing/passthrough, and missing release-channel helper.

---

### Task 2: Implement CLI prerelease selection for `tap install`

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/commands/install.ts`
- Modify: `packages/cli/src/lib/command-metadata.ts`
- Test: `packages/cli/test/install.test.ts`

- [ ] **Step 1: Add `--channel` and `--version` options to `tap install`**

Update the `install` command in `packages/cli/src/cli.ts` so the action passes:

- `runtime`
- `channel`
- `version`

to `installCommand()`.

- [ ] **Step 2: Extend `InstallOptions` and compute a plugin package spec**

In `packages/cli/src/commands/install.ts`:

- add `channel?: string` and `version?: string` to `InstallOptions`
- validate non-empty trimmed values
- introduce a helper that returns:
  - `trusted-agents-tap`
  - `trusted-agents-tap@beta`
  - `trusted-agents-tap@0.2.0-beta.1`

with `version` taking precedence over `channel`

- [ ] **Step 3: Route OpenClaw plugin installation through the selected package spec**

Update `installOpenClawPlugin()` to accept the package spec and invoke:

```bash
openclaw plugins install <plugin-spec>
```

Also add a note to the success output showing the resolved plugin spec when it differs from stable.

- [ ] **Step 4: Update `tap install` examples**

Add concise examples to `packages/cli/src/lib/command-metadata.ts` for:

- `tap install --channel beta`
- `tap install --version 0.2.0-beta.1 --runtime openclaw`

- [ ] **Step 5: Run focused tests until green**

Run:

```bash
bun vitest run packages/cli/test/install.test.ts
```

Expected: all `tap install` tests pass.

---

### Task 3: Implement shell-installer prerelease selection

**Files:**
- Modify: `scripts/install.sh`
- Test: `packages/cli/test/install-script.test.ts`

- [ ] **Step 1: Add usage text and argument parsing**

Update `scripts/install.sh` to support:

- `--channel <name>`
- `--version <semver>`
- `-h` / `--help`

and reject unknown flags or missing values with a short usage message.

- [ ] **Step 2: Resolve the CLI package spec**

Add script logic that chooses:

- `trusted-agents-cli`
- `trusted-agents-cli@beta`
- `trusted-agents-cli@0.2.0-beta.1`

with `--version` taking precedence over `--channel`.

- [ ] **Step 3: Pass the selector through to `tap install`**

Keep the install flow:

- install the CLI via npm
- run `npx trusted-agents-cli install`

but append the same selector flags when provided so prerelease CLI installs can resolve the matching prerelease OpenClaw plugin.

- [ ] **Step 4: Make the new shell-installer tests pass**

Run:

```bash
bun vitest run packages/cli/test/install-script.test.ts
```

Expected: all shell-installer tests pass.

---

### Task 4: Implement and wire release-channel detection

**Files:**
- Create: `scripts/release-channel.mjs`
- Modify: `.github/workflows/release.yml`
- Test: `packages/cli/test/release-channel.test.ts`

- [ ] **Step 1: Implement a tiny release-channel helper**

Create `scripts/release-channel.mjs` that accepts a version string and prints JSON:

```json
{
  "version": "0.2.0-beta.1",
  "isPrerelease": true,
  "npmDistTag": "beta"
}
```

Stable versions should emit `"npmDistTag": null`.

- [ ] **Step 2: Use the helper in the release workflow**

Update `.github/workflows/release.yml` so the publish job:

- computes `TAG_VERSION="${GITHUB_REF_NAME#v}"`
- reads helper output
- publishes prerelease tags with `--tag beta`
- publishes stable tags without an explicit tag

Do this consistently for core, CLI, and plugin.

- [ ] **Step 3: Run the helper tests until green**

Run:

```bash
bun vitest run packages/cli/test/release-channel.test.ts
```

Expected: stable and prerelease mapping tests pass.

---

### Task 5: Update release and install documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/release.md`
- Modify: `skills/trusted-agents/SKILL.md`

- [ ] **Step 1: Update the root README install section**

Add:

- the existing stable install command first
- one short prerelease subsection
- `--channel beta`
- `--version 0.2.0-beta.1`
- one sentence clarifying stable remains the default

- [ ] **Step 2: Update release docs**

Document:

- stable tag example
- prerelease tag example
- prerelease publish behavior to npm `beta`
- that stable continues to own npm `latest`

- [ ] **Step 3: Update the TAP skill docs**

Keep the `Install` section concise while documenting:

- default `tap install`
- `tap install --channel beta`
- `tap install --version 0.2.0-beta.1`

---

### Task 6: Run full verification for the touched surface

**Files:**
- Verify only; no new files

- [ ] **Step 1: Run focused tests for the changed behavior**

Run:

```bash
bun vitest run packages/cli/test/install.test.ts packages/cli/test/install-script.test.ts packages/cli/test/release-channel.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run lint**

Run:

```bash
bun run lint
```

Expected: no Biome errors.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: success.

