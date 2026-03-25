#!/usr/bin/env bash
# Trusted Agents Protocol — install from source
# Usage: run from the repo root after making local changes
#   ./scripts/install-dev.sh
set -euo pipefail

info()  { printf '\033[1;34m[tap-dev]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[tap-dev]\033[0m %s\n' "$1" >&2; }
die()   { error "$1"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Prerequisites ────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "Node.js 18+ is required."
node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
[[ "$node_major" -ge 18 ]] || die "Node.js 18+ required (found v$(node --version))."

command -v bun >/dev/null 2>&1 || die "Bun is required. Install it from https://bun.sh"

# ── Build ────────────────────────────────────────────────────────────────────

info "Installing dependencies..."
cd "$REPO_ROOT"
bun install

info "Building all packages..."
bun run build

# ── Link CLI globally ────────────────────────────────────────────────────────

info "Linking trusted-agents-cli globally..."
cd "$REPO_ROOT/packages/cli"
npm link

# ── Install runtimes ─────────────────────────────────────────────────────────

info "Running tap install..."
tap install

echo ""
info "Done! Local build is now active as 'tap'."
info "To revert to the npm version: npm unlink -g trusted-agents-cli && npm i -g trusted-agents-cli"
