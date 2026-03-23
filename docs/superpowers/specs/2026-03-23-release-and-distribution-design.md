# Release and Distribution Design

**Date:** 2026-03-23
**Issue:** https://github.com/ggonzalez94/trusted-agents/issues/31
**Status:** Approved

## Problem

The project has no release process. Users install by pointing agents at the `main` branch and asking them to clone + build. We need a tag-triggered CI pipeline that publishes all artifacts to their natural distribution channels.

## Decisions

- **Unified versioning** — all packages share one semver version.
- **Tag-triggered release** — push a `v*` tag, CI does the rest.
- **Delete `packages/sdk`** — zero consumers, the orchestrator is legacy. Move skills to repo root.
- **Skills at repo root** — `skills/trusted-agents/` is the single source of truth.
- **No symlinks in distribution** — OpenClaw plugin bundles skills via build-time copy.
- **npm-based install** — no repo clone required for end users.

## Package Matrix

| Package | npm name | Published | `"files"` |
|---------|----------|-----------|-----------|
| `packages/core` | `trusted-agents-core` | Yes | `["dist"]` |
| `packages/cli` | `trusted-agents-cli` | Yes | `["dist"]` |
| `packages/openclaw-plugin` | `trusted-agents-tap` | Yes (un-private) | `["dist", "skills", "openclaw.plugin.json"]` |
| `packages/sdk` | — | Deleted | — |
| `packages/landing` | — | Ignored (stays private) | — |

## Repo Structure (Post-Change)

```
skills/
  trusted-agents/
    SKILL.md                    <- single source of truth
    references/
      permissions-v1.md

packages/
  core/                         <- trusted-agents-core (npm)
  cli/                          <- trusted-agents-cli (npm, bin: tap)
  openclaw-plugin/              <- trusted-agents-tap (npm)
    skills/                     <- .gitignored, populated by build
      trusted-agents/
        SKILL.md
        references/
          permissions-v1.md
    openclaw.plugin.json        <- "skills": ["./skills"]
  landing/                      <- private, not released
```

## CI/CD: Release Workflow

**File:** `.github/workflows/release.yml`
**Trigger:** Push of a `v*` tag.

### Steps

1. **Gate** — checkout, install deps, lint, typecheck, test (same checks as `ci.yml`).
2. **Validate version** — extract version from tag (`v0.2.0` -> `0.2.0`), confirm it matches all `package.json` files.
3. **Build** — `bun run build` (compiles all packages).
4. **Copy skills** — `cp -r skills/trusted-agents packages/openclaw-plugin/skills/trusted-agents`.
5. **Publish to npm** — publish in dependency order: core, then cli, then tap. Uses `NPM_TOKEN` repo secret.
6. **GitHub Release** — `gh release create $TAG --generate-notes` with auto-generated changelog.

### Version Bumping

A `scripts/bump-version.sh` script updates all three `package.json` files to the target version. Run before tagging:

```bash
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: bump version to 0.2.0"
git tag v0.2.0
git push && git push --tags
```

### Existing CI

`.github/workflows/ci.yml` stays untouched — continues running lint, typecheck, build, and test on push/PR.

## Install Paths

### End User: `install.sh`

The install script becomes a thin npm-based installer:

1. Check prerequisites (Node.js >= 18).
2. `npm i -g trusted-agents-cli` — installs the `tap` binary.
3. `tap install` — detects runtimes and sets up skills + plugin.

### `tap install` Runtime Detection

| Runtime detected | Action |
|-----------------|--------|
| Claude Code (`~/.claude` exists) | `npx skills add ggonzalez94/trusted-agents` |
| Codex (`~/.codex` exists) | `npx skills add ggonzalez94/trusted-agents` |
| OpenClaw (`openclaw` on PATH) | `openclaw plugins install trusted-agents-tap` |

No repo clone, no build step, no symlinks for end users.

### Developer/Contributor Path

Not scripted. Documented in README:

```bash
git clone https://github.com/ggonzalez94/trusted-agents.git
cd trusted-agents
bun install && bun run build
cd packages/cli && npm link     # gives local `tap`
tap install                     # links skills for detected runtimes
```

## Skill Distribution

### Three channels, one source

| Channel | Mechanism | Triggered by |
|---------|-----------|-------------|
| Claude Code / Codex | `npx skills add ggonzalez94/trusted-agents` discovers `skills/trusted-agents/SKILL.md` in repo | `tap install` |
| OpenClaw plugin | Build copies skills into plugin dir, bundled in npm tarball | `openclaw plugins install trusted-agents-tap` |
| Local dev | `bun run build` copies skills into plugin; `tap install` uses `npx skills add` for Claude | Developer workflow |

### Why no symlinks

OpenClaw's `isPathInsideWithRealpath` security check (called with `requireRealpath: true`) rejects symlinks that resolve outside the plugin root. Since npm doesn't follow symlinks when creating tarballs, symlinked skills would be missing or broken in the published package. Build-time copy is required.

### Skill updates

Users run `tap install` after upgrading the CLI to refresh skills. For OpenClaw, `openclaw plugins install trusted-agents-tap@latest` pulls the new tarball with updated skills.

## Package Changes Required

### `packages/core/package.json`

Add `"files": ["dist"]` to control what goes in the npm tarball.

### `packages/cli/package.json`

Add `"files": ["dist"]` to control what goes in the npm tarball.

### `packages/openclaw-plugin/package.json`

- Remove `"private": true`.
- Add `"files": ["dist", "skills", "openclaw.plugin.json"]`.
- Change `"trusted-agents-core": "workspace:*"` — bun resolves this at publish time.
- Add `"peerDependencies": { "openclaw": ">=2026.1.29" }` and move `openclaw` from dependencies to peerDependencies.

### `packages/openclaw-plugin/openclaw.plugin.json`

No changes needed. `"skills": ["./skills"]` is already correct.

### `.gitignore`

Add `packages/openclaw-plugin/skills/` to prevent committed copies.

### Delete `packages/sdk/`

Remove the entire directory. Update:
- Root `package.json` workspaces (auto if using `packages/*` glob — verify `sdk` removal doesn't break it).
- Root `tsconfig.json` project references (remove sdk reference).
- Any imports from `trusted-agents-sdk` (none exist).

### Move skills

`packages/sdk/skills/trusted-agents/` -> `skills/trusted-agents/` at repo root.

Remove `packages/sdk/skills/trusted-agents/evals/` — eval data is not needed for distribution and should not ship in the skill. Move evals to a separate location if they need to be preserved.

### Update `packages/openclaw-plugin` build script

Add to `package.json` scripts:
```json
"prebuild": "rm -rf skills && cp -r ../../skills/trusted-agents skills/trusted-agents"
```

Or integrate into the existing `build` script.

## Files To Create

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | Tag-triggered release pipeline |
| `scripts/bump-version.sh` | Updates version in all package.json files |

## Files To Modify

| File | Change |
|------|--------|
| `packages/core/package.json` | Add `"files"` |
| `packages/cli/package.json` | Add `"files"` |
| `packages/cli/src/commands/install.ts` | Use `npx skills add` and `openclaw plugins install` from npm |
| `packages/openclaw-plugin/package.json` | Un-private, add `"files"`, peer dep |
| `scripts/install.sh` | Rewrite to npm-based install |
| `.gitignore` | Add `packages/openclaw-plugin/skills/` |
| `tsconfig.json` | Remove sdk reference |
| `CLAUDE.md` | Remove sdk references, update skill paths |

## Files To Delete

| Path | Reason |
|------|--------|
| `packages/sdk/` | No consumers, orchestrator is legacy |

## Out of Scope

- Landing page deployment.
- npm org / scoped packages (can adopt `@trusted-agents/` later).
- Changesets or automated version bumping (manual bump script is sufficient at this stage).
- Auto-publish on merge to main (tag-based is explicit and preferred).
