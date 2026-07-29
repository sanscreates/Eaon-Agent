#!/usr/bin/env bash
# Eaon Agent — one-line installer (macOS + Linux)
#   curl -fsSL https://raw.githubusercontent.com/sanscreates/Eaon-Agent/main/install.sh | bash
set -e

REPO="sanscreates/Eaon-Agent"
CURRENT_VERSION="1.3.0"
BOLD="\033[1m"; DIM="\033[2m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"

say()  { printf "%b\n" "$1"; }
ok()   { say "${GREEN}✔${RESET} $1"; }
warn() { say "${YELLOW}!${RESET} $1"; }
die()  { say "${RED}✖ $1${RESET}"; exit 1; }

say ""
say "${BOLD}  Eaon Agent${RESET} — token-efficient terminal coding agent"
say "${DIM}  why use many token when few do trick${RESET}"
say ""

# ---------- 0. platform ----------
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "Only macOS and Linux are supported right now." ;;
esac

# ---------- 1. node >= 18 ----------
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 18 ] 2>/dev/null; then
  warn "Node.js >= 18 not found. Trying to install it..."
  if command -v brew >/dev/null 2>&1; then
    brew install node || die "brew install node failed."
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y nodejs npm || die "apt install failed."
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs npm || die "dnf install failed."
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm nodejs npm || die "pacman install failed."
  else
    die "No supported package manager found. Install Node.js >= 18 from https://nodejs.org and re-run."
  fi
fi
command -v node >/dev/null 2>&1 || die "node still not found."
[ "$(node_major)" -ge 18 ] || die "Node >= 18 required (found $(node -v))."
command -v npm  >/dev/null 2>&1 || die "npm not found."
ok "Node $(node -v), npm $(npm -v)"

# ---------- 2. make sure npm global bin is writable & on PATH ----------
NPM_PREFIX="$(npm config get prefix)"
if [ ! -w "$NPM_PREFIX/lib" ] 2>/dev/null && [ ! -w "$NPM_PREFIX" ] 2>/dev/null; then
  warn "Global npm prefix not writable ($NPM_PREFIX). Switching to ~/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  NPM_PREFIX="$HOME/.npm-global"
  case ":$PATH:" in
    *":$NPM_PREFIX/bin:"*) ;;
    *)
      SHELL_RC="$HOME/.bashrc"; [ -n "$ZSH_VERSION" ] && SHELL_RC="$HOME/.zshrc"
      [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
      echo "export PATH=\"$NPM_PREFIX/bin:\$PATH\"" >> "$SHELL_RC"
      export PATH="$NPM_PREFIX/bin:$PATH"
      warn "Added $NPM_PREFIX/bin to PATH in $SHELL_RC (restart your shell later if needed)"
      ;;
  esac
fi

# ---------- 3. install / upgrade ----------
# NOTE: `npm i -g github:...` is unreliable for TS packages (npm runs `prepare`
# for git deps before devDependencies exist, so tsc is missing). Instead:
# clone → npm install (dev deps) → build → pack → install the tarball.
say "Installing eaon-agent from github.com/$REPO ..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v git >/dev/null 2>&1; then
  git clone --quiet --depth 1 "https://github.com/$REPO" "$TMP/src" || die "git clone failed."
else
  warn "git not found — downloading tarball instead."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$TMP/src.tgz" || die "download failed."
  mkdir -p "$TMP/src" && tar -xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1 || die "extract failed."
fi

(
  cd "$TMP/src"
  npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install (deps) failed."
  npm run build >/dev/null 2>&1 || die "build failed."
  npm pack --quiet >/dev/null 2>&1 || die "npm pack failed."
  npm install -g ./eaon-agent-*.tgz || die "npm install -g failed."
) || exit 1

command -v eaon-agent >/dev/null 2>&1 || die "Installed, but 'eaon-agent' is not on PATH. Add $NPM_PREFIX/bin to your PATH."
ok "eaon-agent installed: $(eaon-agent --version 2>/dev/null || echo ok)"

# ---------- 5. auto-update: install newer if available ----------
LATEST=$(npm view eaon-agent version 2>/dev/null || echo "")
if [ -n "$LATEST" ] && [ "$LATEST" != "$CURRENT_VERSION" ]; then
  say ""
  say "${YELLOW}Update available: ${CURRENT_VERSION} → ${LATEST}${RESET}"
  say "  Run ${GREEN}npm install -g eaon-agent@latest${RESET} to upgrade"
fi

# ---------- 6. done ----------
say ""
say "${BOLD}Done.${RESET} Run:"
say "  ${GREEN}eaon-agent setup${RESET}   # connect your providers (first run does this automatically)"
say "  ${GREEN}eaon-agent${RESET}         # start the agent"
say ""
