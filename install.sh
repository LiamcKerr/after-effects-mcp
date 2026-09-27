#!/usr/bin/env bash
# Installs the After Effects MCP on macOS. Non-interactive and safe to re-run.
#   bash install.sh
# NOTE: written for macOS but not yet tested there (the bridge was built and tested on Windows).
# 1. symlinks cep/ into ~/Library/Application Support/Adobe/CEP/extensions/ClaudeBridge
# 2. lets After Effects load unsigned CEP extensions (PlayerDebugMode, current user only)
# 3. registers the MCP server with Claude Code at user scope (if the claude CLI is installed)
# Undo with uninstall.sh. Check with: node scripts/doctor.mjs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER="$ROOT/server/server.mjs"

command -v node >/dev/null || { echo "Node.js is not installed. Install Node 18+ from https://nodejs.org and re-run." >&2; exit 1; }
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 18 ] || { echo "Node $(node -v) is too old. Install Node 18+ and re-run." >&2; exit 1; }
echo "OK   Node $(node -v)"

EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK="$EXT_DIR/ClaudeBridge"
mkdir -p "$EXT_DIR"
if [ -L "$LINK" ]; then
  ln -sfn "$ROOT/cep" "$LINK"; echo "OK   CEP extension linked: $LINK -> $ROOT/cep"
elif [ -e "$LINK" ]; then
  echo "$LINK exists and is not a symlink. Move it aside and re-run." >&2; exit 1
else
  ln -s "$ROOT/cep" "$LINK"; echo "OK   CEP extension linked: $LINK -> $ROOT/cep"
fi

for v in 9 10 11 12 13 14; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done
echo "OK   PlayerDebugMode=1 for CSXS.9 to CSXS.14"

if command -v claude >/dev/null; then
  if claude mcp get after-effects 2>/dev/null | grep -qF "$SERVER"; then
    echo "OK   MCP server already registered with Claude Code: after-effects"
  else
    claude mcp remove after-effects -s user >/dev/null 2>&1 || true
    claude mcp add after-effects -s user -- node "$SERVER" >/dev/null
    echo "OK   MCP server registered with Claude Code (user scope): after-effects"
  fi
else
  echo "SKIP claude CLI not found. For other MCP clients add this server by hand: command node, args [\"$SERVER\"]"
fi

echo
echo "NEXT STEPS (a person has to do these):"
echo "  1. Restart After Effects (quit fully, then open it). The bridge starts with AE."
echo "  2. In AE: After Effects > Settings > Scripting & Expressions > tick 'Allow Scripts to Write Files and Access Network'."
echo "  3. Start a new Claude Code session so it loads the after-effects tools."
echo "Then verify:  node scripts/doctor.mjs   (bridge checks pass once AE is open)"
