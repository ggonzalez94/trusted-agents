#!/usr/bin/env bash
# Trusted Agents Protocol — installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
set -euo pipefail

info()  { printf '\033[1;34m[tap]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[tap]\033[0m %s\n' "$1" >&2; }
die()   { error "$1"; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 18+ is required. Install it from https://nodejs.org"
  local node_major
  node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  if [[ "$node_major" -lt 18 ]]; then
    die "Node.js 18+ is required (found v$(node --version)). Please upgrade."
  fi
}

# ── Install ───────────────────────────────────────────────────────────────────

main() {
  info "Installing Trusted Agents Protocol..."

  check_node

  info "Installing trusted-agents-cli from npm..."
  npm i -g trusted-agents-cli || die "Failed to install trusted-agents-cli from npm."

  info "Setting up runtimes..."
  npx trusted-agents-cli install || die "tap install failed."

  echo ""
  info "Installation complete!"
  info "Run 'tap --help' to get started."
}

main "$@"
