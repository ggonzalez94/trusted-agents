#!/usr/bin/env bash
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate version format (semver without leading v)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format: $VERSION (expected: X.Y.Z or X.Y.Z-prerelease)" >&2
  exit 1
fi

PACKAGES=(
  "packages/core/package.json"
  "packages/tapd/package.json"
  "packages/sdk/package.json"
  "packages/cli/package.json"
  "packages/openclaw-plugin/package.json"
)

for pkg in "${PACKAGES[@]}"; do
  if [[ ! -f "$pkg" ]]; then
    echo "Error: $pkg not found" >&2
    exit 1
  fi

  # Use node for reliable JSON manipulation
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "Updated $pkg to $VERSION"
done

node -e "
  const fs = require('fs');
  const path = 'packages/tapd/src/daemon.ts';
  const source = fs.readFileSync(path, 'utf8');
  const updated = source.replace(
    /export const TAPD_VERSION = \"[^\"]+\";/,
    'export const TAPD_VERSION = \"$VERSION\";',
  );
  if (updated === source) {
    console.error('Error: failed to update TAPD_VERSION in ' + path);
    process.exit(1);
  }
  fs.writeFileSync(path, updated);
"
echo "Updated packages/tapd/src/daemon.ts to $VERSION"

echo ""
echo "All packages bumped to $VERSION. Next steps:"
echo "  bun run release:check"
echo "  git add -A && git commit -m \"chore(release): prepare $VERSION\""
echo "  open a PR, merge it to main, then tag the release merge commit:"
echo "    git tag v$VERSION <merge-sha>"
echo "    git push origin v$VERSION"
echo "  See docs/release.md for the full flow"
