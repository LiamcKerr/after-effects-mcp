# Removes the Claude Bridge: the CEP junction, the Claude Code registration and
# the token file. Leaves PlayerDebugMode alone (other unsigned panels, such as the
# Premiere MCP bridge, rely on it) and leaves this folder in place.

$link = Join-Path $env:APPDATA 'Adobe\CEP\extensions\ClaudeBridge'
$item = Get-Item $link -ErrorAction SilentlyContinue
if ($item -and $item.LinkType -eq 'Junction') {
    # Removing the junction itself; the files it points to stay.
    [System.IO.Directory]::Delete($link)
    "Removed junction $link"
} elseif ($item) {
    "Left $link alone: it is not a junction."
}

claude mcp remove after-effects -s user 2>$null | Out-Null
"Unregistered MCP server after-effects (if it was registered)"

$cfg = Join-Path $env:APPDATA 'ClaudeAEBridge'
if (Test-Path $cfg) { Remove-Item $cfg -Recurse -Force; "Removed $cfg" }

"Restart After Effects to unload the bridge."
