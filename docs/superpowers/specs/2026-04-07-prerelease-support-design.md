# Prerelease Support Design

## Purpose

Add first-class beta / prerelease support to the TAP release process and installer without changing the default stable install path.

Today the repository publishes only through the stable npm flow:

- pushing a `v*` git tag triggers [`.github/workflows/release.yml`](../../../.github/workflows/release.yml)
- the workflow publishes `trusted-agents-core`, `trusted-agents-cli`, and `trusted-agents-tap` to npm
- [`scripts/install.sh`](../../../scripts/install.sh) always installs `trusted-agents-cli` from npm with no channel or version selection

That means prerelease versions are technically possible at the semver level, but operationally unsupported: the publish workflow does not distinguish stable vs prerelease tags, the installer cannot opt into prerelease builds, and the docs do not explain the behavior.

## Goals

- Keep stable installs as the default behavior everywhere
- Support semver prerelease versions such as `0.2.0-beta.1` and `0.2.0-rc.1`
- Publish prerelease builds to npm without moving the `latest` channel away from the most recent stable
- Allow the install script to opt into either a prerelease channel or an exact prerelease version
- Keep the CLI plugin install path aligned so a prerelease CLI can install the matching prerelease OpenClaw plugin
- Document the stable and prerelease paths clearly and succinctly in the installer and README

## Non-Goals

- Introducing separate package names for beta builds
- Supporting multiple prerelease channels in the first iteration (`beta`, `next`, `rc`, etc.)
- Replacing the npm-based install flow with tarball or GitHub-ref installs
- Adding new release infrastructure outside GitHub Actions and npm dist-tags

## Decision Summary

Use semver prerelease versions plus npm dist-tags.

- Stable release example: `v0.1.6`
- Prerelease release example: `v0.2.0-beta.1`
- Stable npm publish behavior: normal publish, which keeps the version on npm `latest`
- Prerelease npm publish behavior: publish with npm dist-tag `beta`

This keeps the default install path unchanged:

```bash
npm i -g trusted-agents-cli
```

And adds two explicit prerelease opt-in paths:

```bash
npm i -g trusted-agents-cli@beta
npm i -g trusted-agents-cli@0.2.0-beta.1
```

## Why This Approach

This repository already uses:

- git tags as the release trigger
- npm as the package distribution channel
- a simple installer that shells out to npm

Dist-tags fit that model with minimal operational churn.

Compared with the alternatives:

- separate beta package names add long-term maintenance and documentation cost
- GitHub/tarball installs make the installer and plugin story more bespoke and fragile

Using a single prerelease dist-tag also preserves a simple mental model:

- `latest` means stable
- `beta` means the newest prerelease
- an exact version means pin exactly what you want

## Release Process Changes

### Tagging convention

The existing `v*` workflow trigger remains unchanged.

Releases are differentiated by the semver inside the tag:

- stable: `v0.1.6`
- prerelease: `v0.2.0-beta.1`, `v0.2.0-beta.2`, `v0.2.0-rc.1`

The existing version validation stays in place. Package versions must still exactly match the pushed tag version with the leading `v` removed.

### Dist-tag policy

Use a single prerelease npm tag: `beta`.

Mapping:

- any tag version without a prerelease suffix publishes normally and remains the stable `latest`
- any tag version with a prerelease suffix publishes with `--tag beta`

This intentionally maps both `-beta.*` and `-rc.*` versions to the same npm channel in v1. That keeps the workflow and documentation simple while still allowing exact-version installs when users need a particular build.

### Workflow behavior

[`.github/workflows/release.yml`](../../../.github/workflows/release.yml) should compute a shared publish mode from `TAG_VERSION="${GITHUB_REF_NAME#v}"`.

Rules:

- if `TAG_VERSION` contains `-`, treat it as a prerelease and set `NPM_DIST_TAG=beta`
- otherwise treat it as stable and publish without an explicit tag

That publish mode must be used consistently for:

- `trusted-agents-core`
- `trusted-agents-cli`
- `trusted-agents-tap`

This consistency matters because the CLI and OpenClaw plugin are released together and are version-coupled.

### Release docs

[`docs/release.md`](../../../docs/release.md) should explicitly document:

- stable tag format and publish outcome
- prerelease tag format and publish outcome
- example bump/tag commands for both stable and prerelease releases
- that prereleases do not move npm `latest`

## Installer Changes

### Shell installer interface

[`scripts/install.sh`](../../../scripts/install.sh) should accept two new optional selectors:

- `--channel <name>`
- `--version <semver>`

Supported behavior:

- default: install stable with `npm i -g trusted-agents-cli`
- `--channel beta`: install `trusted-agents-cli@beta`
- `--version 0.2.0-beta.1`: install `trusted-agents-cli@0.2.0-beta.1`
- if both are passed, `--version` wins

Example user-facing commands:

```bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --channel beta
curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash -s -- --version 0.2.0-beta.1
```

### Shell installer UX

The script should include a short inline usage block near the top so the prerelease opt-in path is visible without opening the README.

The script should keep its current behavior after CLI installation:

- install the selected CLI version from npm
- run `npx trusted-agents-cli install`

When `--channel` or `--version` is provided to the shell installer, it should pass the same selector through to `npx trusted-agents-cli install ...` so the OpenClaw plugin install path can resolve the matching prerelease package instead of falling back to stable.

The selected package spec should be echoed in the installer logs so users can confirm whether stable, channel, or exact version was installed.

## CLI `tap install` Changes

### Why `tap install` also needs prerelease awareness

Installing a prerelease CLI alone is not sufficient.

[`packages/cli/src/commands/install.ts`](../../../packages/cli/src/commands/install.ts) currently installs the OpenClaw plugin with:

```text
openclaw plugins install trusted-agents-tap
```

That always resolves through the default npm channel behavior. If the CLI is a beta build but the plugin install path still pulls stable, the runtime surfaces can diverge.

### Proposed CLI interface

Extend `tap install` with optional prerelease selectors that mirror the shell installer intent:

- `tap install --channel beta`
- `tap install --version 0.2.0-beta.1`

Scope:

- skills installation for Claude/Codex stays unchanged
- OpenClaw plugin installation uses the selected channel/version when provided
- no selector means the current stable/default behavior

Behavior rules:

- `--version` wins over `--channel`
- `--channel` and `--version` affect only the npm-installed OpenClaw plugin path
- skill installation remains sourced from the main repository skill install flow

### OpenClaw plugin install command

The implementation should construct the plugin package spec as:

- default: `trusted-agents-tap`
- channel: `trusted-agents-tap@beta`
- exact version: `trusted-agents-tap@0.2.0-beta.1`

And pass that full spec to `openclaw plugins install`.

This keeps prerelease selection explicit and visible in tests and installer notes.

## Documentation Changes

### `scripts/install.sh`

Add a succinct usage block documenting:

- default stable install
- beta channel install
- exact version install

### Root `README.md`

In the install section:

- keep the stable install command first
- add one short prerelease subsection immediately after it
- show one `--channel beta` example and one exact `--version` example
- clarify in one sentence that stable remains the default unless explicitly overridden

### TAP skill documentation

Because this change extends the public CLI contract for `tap install`, update the canonical TAP skill at [`skills/trusted-agents/SKILL.md`](../../../skills/trusted-agents/SKILL.md).

That update should stay concise and document:

- the default stable `tap install` behavior
- `tap install --channel beta`
- `tap install --version <semver>`

The OpenClaw plugin build-time skill copy will pick this up automatically.

### `docs/release.md`

Add a prerelease subsection covering:

- how to pick a prerelease semver
- how to bump versions with `scripts/bump-version.sh`
- how tag suffixes affect npm dist-tags
- examples for stable and prerelease tag creation

## Error Handling

### Installer input validation

[`scripts/install.sh`](../../../scripts/install.sh) should:

- reject unknown flags with a short usage message
- reject missing values for `--channel` and `--version`
- reject an empty channel or version string

It does not need full semver validation in the shell script. npm can remain the source of truth for whether the requested package spec exists. The script should only validate obvious misuse.

### CLI input validation

`tap install` should:

- reject empty `--channel` or `--version`
- prefer `--version` when both are supplied
- surface the exact package spec used in the JSON/text output notes

## Testing

### Installer tests

Add coverage for:

- default stable install
- `--channel beta`
- `--version 0.2.0-beta.1`
- `--version` taking precedence over `--channel`
- invalid argument handling

### CLI tests

Extend [`packages/cli/test/install.test.ts`](../../../packages/cli/test/install.test.ts) to cover:

- default OpenClaw plugin install
- `tap install --channel beta`
- `tap install --version 0.2.0-beta.1`
- precedence when both selectors are passed

Assertions should verify the exact `openclaw plugins install ...` command invoked.

### Release workflow verification

Keep the workflow shell logic small and explicit.

The minimum acceptable verification is:

- stable publish path visibly omits `--tag`
- prerelease publish path visibly includes `--tag beta`

If extracting this logic into a shared script meaningfully simplifies the workflow, that is acceptable, but it is not required for this change.

## Rollout Notes

- Existing stable release behavior should remain unchanged
- Existing stable install commands should continue to work unchanged
- Users only enter prerelease mode when they opt in with `--channel` or `--version`
- Existing prerelease semver support in [`scripts/bump-version.sh`](../../../scripts/bump-version.sh) becomes part of the documented release process instead of an implicit capability

## Open Questions

None for v1.

The design intentionally avoids introducing multiple prerelease channels. If the team later wants separate `beta` and `rc` npm tags, that can be added as a follow-up once the single-channel prerelease flow has proven out.
