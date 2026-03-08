#!/usr/bin/env bash
# Trusted Agents Protocol — installer script
# Usage: curl -fsSL https://raw.githubusercontent.com/ggonzalez94/trusted-agents/main/scripts/install.sh | bash
# Or:    bash scripts/install.sh [--uninstall] [--skip-skills] [--branch <branch>]
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────

REPO_URL="${TAP_REPO_URL:-https://github.com/ggonzalez94/trusted-agents.git}"
BRANCH="${TAP_BRANCH:-main}"
SOURCE_DIR="${TAP_SOURCE_DIR:-${HOME}/.local/share/trustedagents/src}"
BIN_DIR="${TAP_BIN_DIR:-${HOME}/.local/bin}"
SKIP_SKILLS=false
UNINSTALL=false

RUNTIMES=("claude" "codex" "openclaw")

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m[tap]\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m[tap]\033[0m %s\n' "$1" >&2; }
error() { printf '\033[1;31m[tap]\033[0m %s\n' "$1" >&2; }
die()   { error "$1"; exit 1; }

# ── Argument parsing ─────────────────────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uninstall)    UNINSTALL=true; shift ;;
      --skip-skills)  SKIP_SKILLS=true; shift ;;
      --repo-url)     REPO_URL="$2"; shift 2 ;;
      --branch)       BRANCH="$2"; shift 2 ;;
      --bin-dir)      BIN_DIR="$2"; shift 2 ;;
      --source-dir)   SOURCE_DIR="$2"; shift 2 ;;
      -h|--help)      usage; exit 0 ;;
      *)              die "Unknown option: $1 (try --help)" ;;
    esac
  done
}

usage() {
  cat <<'USAGE'
Usage: install.sh [OPTIONS]

Install the Trusted Agents Protocol CLI (tap), skill files, and runtime integrations.

Options:
  --uninstall       Remove tap binary and skill symlinks
  --skip-skills     Skip linking generic TAP skill files into agent runtimes
  --repo-url URL    Git repository URL (default: GitHub)
  --branch BRANCH   Git branch to clone (default: main)
  --bin-dir DIR     Binary install directory (default: ~/.local/bin)
  --source-dir DIR  Source checkout directory (default: ~/.local/share/trustedagents/src)
  -h, --help        Show this help message

Environment variables:
  TAP_REPO_URL      Override --repo-url
  TAP_BRANCH        Override --branch
  TAP_SOURCE_DIR    Override --source-dir
  TAP_BIN_DIR       Override --bin-dir
USAGE
}

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_prerequisites() {
  command -v git >/dev/null 2>&1 || die "git is required but not found. Install it and try again."

  if command -v bun >/dev/null 2>&1; then
    PKG_MGR="bun"
    RUNNER="bun"
    return
  fi

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local node_major
    node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
    if [[ "$node_major" -lt 18 ]]; then
      die "Node.js 18+ is required (found v$(node --version)). Please upgrade or install bun (https://bun.sh)."
    fi
    PKG_MGR="npm"
    RUNNER="npx"
    return
  fi

  die "Either bun (https://bun.sh) or Node.js 18+ with npm is required. Install one and try again."
}

# ── Source management ─────────────────────────────────────────────────────────

setup_source() {
  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    info "Updating existing source at ${SOURCE_DIR}..."
    git -C "$SOURCE_DIR" fetch origin "$BRANCH" --depth 1 2>&1 || die "git fetch failed"
    git -C "$SOURCE_DIR" reset --hard "origin/${BRANCH}" 2>&1 || die "git reset failed"
  else
    info "Cloning repository into ${SOURCE_DIR}..."
    mkdir -p "$(dirname "$SOURCE_DIR")"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SOURCE_DIR" 2>&1 || die "git clone failed"
  fi
}

# ── Build ─────────────────────────────────────────────────────────────────────

build_project() {
  info "Installing dependencies (${PKG_MGR})..."
  (cd "$SOURCE_DIR" && $PKG_MGR install) || die "Dependency installation failed"

  info "Building project..."
  if [[ "$PKG_MGR" == "bun" ]]; then
    (cd "$SOURCE_DIR" && bun run build) || die "Build failed. Check that bun is up to date."
  else
    (cd "$SOURCE_DIR" && npm run build) || die "Build failed. Check that Node.js 18+ is installed."
  fi

  local bin_target="${SOURCE_DIR}/packages/cli/dist/bin.js"
  [[ -f "$bin_target" ]] || die "Build succeeded but bin.js not found at ${bin_target}. This is a bug — please open an issue."
}

# ── Binary installation ──────────────────────────────────────────────────────

install_binary() {
  local bin_target="${SOURCE_DIR}/packages/cli/dist/bin.js"

  mkdir -p "$BIN_DIR" 2>/dev/null || die "Cannot create ${BIN_DIR}. Try: --bin-dir /path/you/can/write"

  if [[ -e "${BIN_DIR}/tap" && ! -L "${BIN_DIR}/tap" ]]; then
    warn "${BIN_DIR}/tap exists and is not a symlink — skipping binary install"
    return
  fi

  chmod +x "$bin_target"
  ln -sf "$bin_target" "${BIN_DIR}/tap"
  info "Linked tap -> ${bin_target}"
}

# ── Product install ───────────────────────────────────────────────────────────

run_product_install() {
  local tap_bin="${SOURCE_DIR}/packages/cli/dist/bin.js"
  chmod +x "$tap_bin" 2>/dev/null || true
  [[ -x "$tap_bin" ]] || die "tap binary not found at ${tap_bin}"

  info "Running TAP runtime install..."
  local args=("install" "--source-dir" "$SOURCE_DIR")
  if [[ "$SKIP_SKILLS" == true ]]; then
    args+=("--skip-skills")
  fi

  "$tap_bin" "${args[@]}" || die "TAP runtime install failed"
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
  echo ""
  info "Installation complete!"
  echo ""

  if [[ -L "${BIN_DIR}/tap" ]]; then
    echo "  Binary: ${BIN_DIR}/tap"
  fi

  for runtime in "${RUNTIMES[@]}"; do
    local link_path="${HOME}/.${runtime}/skills/trusted-agents"
    if [[ -L "$link_path" ]]; then
      echo "  Skills: ${link_path}"
    fi
  done

  echo ""

  # Check if BIN_DIR is on PATH
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      warn "${BIN_DIR} is not in your PATH."
      echo ""
      echo "  Add it to your shell profile:"
      echo "    export PATH=\"${BIN_DIR}:\$PATH\""
      echo ""
      ;;
  esac

  info "Run 'tap --help' to get started."
}

# ── Uninstall ─────────────────────────────────────────────────────────────────

uninstall() {
  info "Uninstalling Trusted Agents Protocol..."

  # Remove binary symlink (only if it points into our source)
  if [[ -L "${BIN_DIR}/tap" ]]; then
    local target
    target=$(readlink "${BIN_DIR}/tap")
    if [[ "$target" == *"trustedagents/src/"* ]]; then
      rm "${BIN_DIR}/tap"
      info "Removed ${BIN_DIR}/tap"
    else
      warn "${BIN_DIR}/tap does not point to our source — skipping"
    fi
  fi

  # Remove skill symlinks (only if they point into our source)
  for runtime in "${RUNTIMES[@]}"; do
    local link_path="${HOME}/.${runtime}/skills/${SKILL_LINK_NAME}"
    if [[ -L "$link_path" ]]; then
      local target
      target=$(readlink "$link_path")
      if [[ "$target" == *"trustedagents/src/"* ]]; then
        rm "$link_path"
        info "Removed ${link_path}"
      else
        warn "${link_path} does not point to our source — skipping"
      fi
    fi
  done

  # Optionally remove source directory
  if [[ -d "$SOURCE_DIR" ]]; then
    if [[ -t 0 ]]; then
      echo ""
      printf '%s' "Remove source directory ${SOURCE_DIR}? [y/N] "
      read -r answer
      if [[ "$answer" =~ ^[Yy]$ ]]; then
        rm -rf "$SOURCE_DIR"
        info "Removed ${SOURCE_DIR}"
      else
        info "Kept source directory at ${SOURCE_DIR}"
      fi
    else
      info "Source directory kept at ${SOURCE_DIR} (run interactively to remove)"
    fi
  fi

  echo ""
  info "Uninstall complete. Agent data (keys, contacts, conversations) was not touched."
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"

  if [[ "$UNINSTALL" == true ]]; then
    uninstall
    exit 0
  fi

  check_prerequisites
  setup_source
  build_project
  install_binary
  run_product_install
  print_summary
}

main "$@"
