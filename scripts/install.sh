#!/usr/bin/env bash
# Trusted Agents Protocol — installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
set -euo pipefail

info()  { printf '\033[1;34m[tap]\033[0m %s\n' "$1"; }
error() { printf '\033[1;31m[tap]\033[0m %s\n' "$1" >&2; }
die()   { error "$1"; exit 1; }

usage() {
  cat <<'EOF'
Trusted Agents Protocol installer

Usage:
  bash install.sh
  bash install.sh --channel beta
  bash install.sh --version 0.2.0-beta.1

Options:
  --channel <name>    Install from an npm dist-tag such as beta
  --version <semver>  Install an exact npm package version
  -h, --help          Show this help text
EOF
}

CHANNEL=""
VERSION=""

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 18+ is required. Install it from https://nodejs.org"
  local node_major
  node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  if [[ "$node_major" -lt 18 ]]; then
    die "Node.js 18+ is required (found v$(node --version)). Please upgrade."
  fi
}

# ── Arguments ─────────────────────────────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --channel)
        shift
        [[ $# -gt 0 ]] || die "Missing value for --channel"
        [[ -n "${1:-}" && "${1#-}" != "$1" ]] && die "Missing value for --channel"
        CHANNEL="$1"
        ;;
      --version)
        shift
        [[ $# -gt 0 ]] || die "Missing value for --version"
        [[ -n "${1:-}" && "${1#-}" != "$1" ]] && die "Missing value for --version"
        VERSION="$1"
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

resolve_cli_package_spec() {
  if [[ -n "$VERSION" ]]; then
    printf 'trusted-agents-cli@%s\n' "$VERSION"
    return
  fi

  if [[ -n "$CHANNEL" ]]; then
    printf 'trusted-agents-cli@%s\n' "$CHANNEL"
    return
  fi

  printf 'trusted-agents-cli\n'
}

# ── Install ───────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  info "Installing Trusted Agents Protocol..."

  check_node

  local cli_package_spec
  cli_package_spec="$(resolve_cli_package_spec)"

  info "Installing ${cli_package_spec} from npm..."
  npm i -g "$cli_package_spec" || die "Failed to install ${cli_package_spec} from npm."

  info "Setting up runtimes..."
  if [[ -n "$VERSION" ]]; then
    npx -y "$cli_package_spec" install --version "$VERSION" || die "tap install failed."
  elif [[ -n "$CHANNEL" ]]; then
    npx -y "$cli_package_spec" install --channel "$CHANNEL" || die "tap install failed."
  else
    npx -y "$cli_package_spec" install || die "tap install failed."
  fi

  echo ""
  info "Installation complete!"
  info "Run 'tap --help' to get started."
}

main "$@"
