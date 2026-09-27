#!/usr/bin/env bash
# Removes the After Effects MCP on macOS: the CEP symlink, the Claude Code registration and
# the token folder. Leaves PlayerDebugMode alone (other unsigned panels may rely on it) and
# leaves this folder in place. NOTE: not yet tested on macOS.
LINK="$HOME/Library/Application Support/Adobe/CEP/extensions/ClaudeBridge"
if [ -L "$LINK" ]; then rm "$LINK"; echo "Removed symlink $LINK"; elif [ -e "$LINK" ]; then echo "Left $LINK alone: not a symlink."; fi
command -v claude >/dev/null && claude mcp remove after-effects -s user >/dev/null 2>&1 && echo "Unregistered MCP server after-effects"
CFG="$HOME/Library/Application Support/ClaudeAEBridge"
[ -d "$CFG" ] && rm -rf "$CFG" && echo "Removed $CFG"
echo "Restart After Effects to unload the bridge."
