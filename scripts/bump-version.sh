#!/usr/bin/env bash
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate version format (semver without leading v)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: Invalid version format: $VERSION (expected: X.Y.Z or X.Y.Z-prerelease)" >&2
  exit 1
fi

PACKAGES=(
  "packages/core/package.json"
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

echo ""
echo "All packages bumped to $VERSION. Next steps:"
echo "  git add -A && git commit -m \"chore: bump version to $VERSION\""
echo "  git tag v$VERSION"
echo "  git push && git push --tags"
