# After Effects MCP: instructions for AI agents

You are installing (or using) an MCP server that lets you drive the copy of Adobe After Effects open on this computer. Follow the steps in order. Every script prints `OK`, `SKIP` or an error. Don't guess past an error: use the fix table below.

## Install

1. **Check the prerequisites.**
   - `node -v` must print v18 or newer. If not, stop and ask the user to install Node.js 18+ from https://nodejs.org.
   - Adobe After Effects 2022 or newer must be installed.
   - Windows is tested. macOS support is written but untested, so tell the user that before you start.
2. **Put the repo somewhere permanent.** The installer links After Effects to this folder, so it must not be moved or deleted afterwards. For example:
   - Windows: `git clone https://github.com/LiamcKerr/after-effects-mcp.git "$env:USERPROFILE\after-effects-mcp"`
   - macOS: `git clone https://github.com/LiamcKerr/after-effects-mcp.git ~/after-effects-mcp`
3. **Run the installer from the repo folder.** It is non-interactive, safe to re-run, and changes only the current user.
   - Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`
   - macOS: `bash install.sh`

   It does three things:
   - links `cep/` into Adobe's CEP extensions folder
   - sets `PlayerDebugMode=1` so After Effects loads this unsigned extension
   - runs `claude mcp add after-effects -s user -- node <repo>/server/server.mjs`

   If the `claude` CLI isn't present, it prints the command and path to register by hand. See "Other MCP clients" in README.md.
4. **Hand over to the user for three things you cannot do.** Tell them plainly:
   1. Quit After Effects completely and open it again. The bridge starts with AE.
   2. Open AE Preferences > Scripting & Expressions and tick **"Allow Scripts to Write Files and Access Network"**. Frame previews and renders need it. On macOS: After Effects > Settings.
   3. Start a new Claude Code session so the `after-effects` tools load.
5. **Verify.** Run `node scripts/doctor.mjs --json` in the repo folder. `"ok": true` means installed. Then, in the new session, call `ae_status`. It should return the AE version and the open project.

## If a check fails

| `doctor` check | Meaning | Fix |
|---|---|---|
| `node` | Node older than 18 or missing | The user installs Node 18+; re-run the installer |
| `after-effects` | Not in the default install folder | Ignore if AE is installed elsewhere; otherwise the user installs AE 2022+ |
| `cep-extension` | The extension link is missing or points elsewhere | Re-run the installer from this repo folder |
| `player-debug-mode` | AE would refuse the unsigned extension | Re-run the installer, then the user restarts AE |
| `claude-code-registration` | Claude Code doesn't know the server | `claude mcp add after-effects -s user -- node "<repo>/server/server.mjs"` |
| `bridge-config` | The bridge has never started | The user opens (or restarts) After Effects once |
| `bridge-running` | AE closed, bridge not loaded, or AE busy | The user opens AE. If it's open: Window > Extensions > Claude Bridge > **Restart bridge**. If there's no "Claude Bridge" in that menu, fix `cep-extension` / `player-debug-mode` and restart AE. If AE is rendering or showing a dialog, wait or ask the user to close the dialog |
| `bridge-version` | AE is still running an older bridge | Restart bridge (as above) or restart AE |
| `ffmpeg` (optional) | No ffmpeg on PATH | Only needed to turn `sequence` renders into .mp4 automatically |

`ae_status` saying *"The After Effects bridge is not reachable"* is the `bridge-running` row. `ae_preview_frame` failing with a file permission error means step 4.2 wasn't done.

## Using the tools well

- **Start with `ae_status`.** Inspect before changing anything: `ae_list_items` and `ae_comp_info` return ids you can reuse.
- **`ae_run_script` runs ExtendScript**, which is ES3:
  - `var` and `function` only. No `let`/`const`, arrow functions, template strings or `JSON` object.
  - Reserved words must be quoted as object keys (`{"in": 1}`, not `{in: 1}`).
  - Top-level `return` sends a value back, and `log(...)` collects messages.
- **Never open a dialog.** `alert`, `confirm`, `prompt`, or anything that makes AE warn (a missing-font dialog, an "overwrite?" prompt) freezes AE and the bridge until a person clicks. If AE stops answering, ask the user whether a dialog is open.
- **Every change is one undo step named "Claude: …"**, so the user can press Edit > Undo.
- **Check your visual work** with `ae_preview_frame`, which returns a PNG of any frame.
- **Rendering:**
  - Short or light comps: `ae_render` with defaults. It waits and writes the file with AE's default template, which is H.264 .mp4 in AE 2026.
  - Long or heavy comps: use `format: "sequence"` and `wait: false`. You get a job id straight away. Poll `ae_render_status` every 30–60 s and tell the user the percentage and ETA it reports. When it's done, if the output path ends in .mp4 and ffmpeg is installed, `ae_render_status` encodes the MP4. Sequence renders (TIFF by default) carry no audio, so mux it separately if needed.
  - While a render runs, AE answers nothing else. Only `ae_render_status` works. Don't queue other calls.
- **Heavy 4K effects** (radial blur, big blurs, 3D templates) are slow per frame. Preview single frames before committing to a full render.

## Updating

Run `git pull` in the repo folder. Then either restart After Effects, or use Window > Extensions > Claude Bridge > **Restart bridge**. Server changes need a new Claude Code session. Run `node scripts/doctor.mjs` to confirm the bridge version.

## Uninstalling

- Windows: `powershell -ExecutionPolicy Bypass -File uninstall.ps1`
- macOS: `bash uninstall.sh`

Both remove the link, the Claude Code registration and the token folder, then leave the repo folder for the user to delete.
