# Release Process

This repository publishes packages from the `Release` GitHub Actions workflow in [`.github/workflows/release.yml`](../.github/workflows/release.yml). A release starts when a tag matching `v*` is pushed.

## What gets released

- `trusted-agents-core`
- `trusted-agents-cli`
- `trusted-agents-tap`

The workflow validates that all three package versions exactly match the pushed tag, runs lint/typecheck/build/test, verifies package metadata, publishes to npm in dependency order, and then creates a GitHub Release.

## Prepare the release PR

1. Pick the next semver.
   - Patch: `0.1.3` -> `0.1.4`
   - Minor: `0.1.3` -> `0.2.0`
   - Major: `0.1.3` -> `1.0.0`
2. Bump the published package versions:

```bash
./scripts/bump-version.sh 0.1.4
```

3. Run the same checks the release should satisfy:

```bash
bun run release:check
```

4. Commit the version bump and any accompanying release-prep docs.
5. Open a PR and merge it to `main`.

## Cut the release after merge

After the PR is merged, tag the exact merge commit for that release PR:

```bash
git checkout main
git pull --ff-only origin main
MERGE_SHA=<release-pr-merge-commit>
git tag v0.1.4 "$MERGE_SHA"
git push origin v0.1.4
```

If you are tagging immediately after the release PR merges and nothing else landed on
`main`, `MERGE_SHA` can be `HEAD`.

That tag push starts the publish workflow automatically.

## Monitor the workflow

1. Open the `Release` workflow run for the pushed tag.
2. Confirm the jobs pass through:
   - version validation
   - package verification
   - npm publish for all three packages
   - GitHub Release creation
3. If a rerun is needed, the workflow is designed to skip packages or GitHub releases that already exist.

## Release prerequisites

- `NPM_TOKEN` must be configured in GitHub Actions secrets.
- The repository must allow the workflow to create releases and publish with provenance.
- The tag must match the package versions exactly, without a leading `v` in the manifest version fields.
