# After Effects MCP

This lets Claude Code, or any MCP client, drive the Adobe After Effects that's open on your computer. It can:

- inspect projects and comps
- build and animate layers with ExtendScript
- preview frames as images
- import files
- render, with live progress on long renders

There are no dependencies beyond Node.js 18+.

> **Installing with an AI agent?** Tell it: *"Install the After Effects MCP from https://github.com/LiamcKerr/after-effects-mcp by following its AGENTS.md."* The file has step-by-step instructions, a verification script and a fix for every failure.

## How it works

```
MCP client ──stdio──> server/server.mjs ──HTTP 127.0.0.1:47670 + token──> Claude Bridge (CEP extension inside AE) ──> ExtendScript
```

- **`cep/`** is a small CEP extension with two parts:
  - An invisible **host**. After Effects starts it on launch, and it runs a local server that passes scripts to AE's script engine one at a time.
  - A status **panel**, under Window > Extensions > Claude Bridge. It shows whether the bridge is up and lists recent calls, and its **Restart bridge** button reloads the host.
- **`server/`** is the MCP server: stdio JSON-RPC with no dependencies. All the tool logic lives here.

## Tools

| Tool | What it does |
|---|---|
| `ae_status` | Bridge check, AE version, open project, active item, and whether scripts may write files |
| `ae_list_items` | Project items with ids: comps, footage, folders |
| `ae_comp_info` | Comp settings and layers: timing, switches, parent, effects, text, transform, keyframe counts |
| `ae_preview_frame` | Renders one frame to PNG and returns it as an image |
| `ae_import` | Imports a file or image sequence, optionally into a named folder |
| `ae_render` | Renders a comp through the render queue. Either waits, or (`wait: false`) returns a job id at once. `format: "sequence"` writes numbered frames you can count (TIFF by default), then encodes an .mp4 with ffmpeg |
| `ae_render_status` | Progress of a render: frames done, percent, time per frame, ETA. It answers while AE is busy rendering |
| `ae_run_script` | Runs any ExtendScript (ES3) and returns the result |

Every change is one undo step named "Claude: …", so Edit > Undo in AE reverses it.

## Install

The requirements are After Effects 2022 or newer and Node.js 18 or newer. ffmpeg is optional (for .mp4 from sequence renders). The installer registers the server with Claude Code if the `claude` CLI is installed.

```powershell
# Windows (tested: Windows 11, After Effects 2025 and 2026)
git clone https://github.com/LiamcKerr/after-effects-mcp.git "$env:USERPROFILE\after-effects-mcp"
cd "$env:USERPROFILE\after-effects-mcp"
powershell -ExecutionPolicy Bypass -File install.ps1
```

```bash
# macOS (written for macOS but not yet tested there)
git clone https://github.com/LiamcKerr/after-effects-mcp.git ~/after-effects-mcp
cd ~/after-effects-mcp && bash install.sh
```

Then do three things by hand:

1. Restart After Effects.
2. Tick **Preferences > Scripting & Expressions > "Allow Scripts to Write Files and Access Network"**.
3. Start a new Claude Code session.

Check everything with:

```bash
node scripts/doctor.mjs        # PASS/FAIL per piece, with the fix for each failure
```

Keep the repo folder where it is: After Effects loads the extension through a link to `cep/`.

### Other MCP clients

Register a stdio server with command `node` and argument `<repo>/server/server.mjs`. For Claude Desktop's `claude_desktop_config.json`:

```json
{ "mcpServers": { "after-effects": { "command": "node", "args": ["C:\\Users\\you\\after-effects-mcp\\server\\server.mjs"] } } }
```

## Rendering long comps

```text
ae_render { comp: "Main", output_path: "D:/renders/main.mp4", format: "sequence", wait: false }
  -> { job: "render-…", frames: 1800 }
ae_render_status { job: "render-…" }
  -> { status: "running", framesDone: 612, percent: 34, secondsPerFrame: 1.9, etaSeconds: 2257 }
  -> { status: "done", encodedBytes: 48211003, file: "D:/renders/main.mp4" }
```

- The frames go to `main_frames/` next to the output. When the render is done, `ae_render_status` encodes them to the .mp4 with ffmpeg.
- PNG sequences carry no audio, so mux your soundtrack separately.
- `format: "template"` (the default) renders straight to one file with an output module template, but AE reports no progress until it finishes.

## Security

- **Local only.** The bridge listens on 127.0.0.1 and needs a random token from `bridge.json`: `%APPDATA%\ClaudeAEBridge` on Windows, `~/Library/Application Support/ClaudeAEBridge` on macOS. The token is created on first run and readable by your user only.
- **No browsers.** Requests with an `Origin` header, or a `Host` other than 127.0.0.1/localhost, are refused. That blocks web pages and DNS rebinding.
- **Full scripting power.** `ae_run_script` can do anything ExtendScript can do in the open project. That's the point, so only your own MCP client should hold the token.

## Gotchas

- **Dialogs freeze everything.** `alert`, `confirm`, `prompt`, or any AE warning dialog (missing fonts, "overwrite?", "undo group mismatch") blocks AE and the bridge until someone clicks. `ae_render` avoids the ones it can: it deletes an existing output file first and never renders inside an undo group.
- **One job at a time.** While AE renders or shows a dialog, other calls wait; only `ae_render_status` answers. A timeout on the MCP side doesn't stop the script in AE.
- **One AE at a time.** If two versions of AE are open, only the first gets port 47670.
- **Preview permission.** `ae_preview_frame` uses `saveFrameToPng`. A file permission error means the scripting preference above isn't ticked.
- **ES3 only.** ExtendScript is ES3: no `let`/`const`, arrow functions, template strings or `JSON`, and reserved words must be quoted as object keys.

## Testing without After Effects

```bash
node test/fake-ae.mjs                                  # real host.js + bridge.jsx with a stand-in AE on :47670
node test/smoke.mjs                                    # initialize, tools/list, ae_status
node test/smoke.mjs ae_run_script @test/roundtrip.json
```

The stand-in runs modern JavaScript, so it won't catch ES3-only mistakes. Always finish with a live check in AE.

## Uninstall

`uninstall.ps1` (Windows) or `uninstall.sh` (macOS) removes the link, the Claude Code registration and the token folder, and leaves the repo in place.

## Licence

MIT. See [LICENSE](LICENSE).
