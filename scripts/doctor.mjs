#!/usr/bin/env node
// Checks every piece of the After Effects MCP install and prints a fix for anything
// that fails. Safe to run any time; changes nothing.
//   node scripts/doctor.mjs            human-readable
//   node scripts/doctor.mjs --json     machine-readable (for agents)
// Exit code: 0 if everything required passes, 1 otherwise.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, CONFIG_FILE } from "../server/paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CEP_SRC = path.join(ROOT, "cep");
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const EXT_DIR = WIN ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Adobe", "CEP", "extensions")
  : path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
const LINK = path.join(EXT_DIR, "ClaudeBridge");
const INSTALL = WIN ? "powershell -ExecutionPolicy Bypass -File install.ps1" : "bash install.sh";

const checks = [];
const add = (name, level, ok, detail, fix) => checks.push({ name, level, ok, detail, fix: ok ? undefined : fix });
// The claude CLI is a script shim on Windows, so it needs a shell: pass it one command string.
const run = (cmd, args, shell = false) => {
  const r = shell ? spawnSync([cmd, ...args].join(" "), { encoding: "utf8", shell: true }) : spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
};

// 1. Platform and Node
add("platform", "required", WIN || MAC, `${process.platform} ${os.release()}`, "After Effects runs on Windows and macOS only.");
const major = Number(process.versions.node.split(".")[0]);
add("node", "required", major >= 18, `Node ${process.versions.node}`, "Install Node.js 18 or newer (https://nodejs.org) and re-run.");

// 2. After Effects installed
let aeFound = [];
try {
  if (WIN) aeFound = fs.readdirSync("C:\\Program Files\\Adobe").filter((d) => /^Adobe After Effects/i.test(d));
  if (MAC) aeFound = fs.readdirSync("/Applications").filter((d) => /^Adobe After Effects/i.test(d));
} catch {}
add("after-effects", "required", aeFound.length > 0, aeFound.join(", ") || "not found in the default location", "Install Adobe After Effects (2022 or newer). If it is installed elsewhere this check can be ignored.");

// 3. CEP extension linked
let linkOk = false, linkDetail = "missing";
try {
  const real = fs.realpathSync(LINK);
  linkOk = path.resolve(real).toLowerCase() === path.resolve(CEP_SRC).toLowerCase();
  linkDetail = linkOk ? `${LINK} -> ${real}` : `${LINK} points to ${real}, not this repo`;
} catch {}
add("cep-extension", "required", linkOk, linkDetail, `Run: ${INSTALL}   (links ${CEP_SRC} into ${EXT_DIR})`);

// 4. Unsigned extensions allowed (PlayerDebugMode)
let debugOn = [];
for (const v of [9, 10, 11, 12, 13, 14]) {
  if (WIN) { const r = run("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode"]); if (/PlayerDebugMode\s+REG_SZ\s+1/.test(r.out)) debugOn.push(v); }
  if (MAC) { const r = run("defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"]); if (r.out.trim() === "1") debugOn.push(v); }
}
add("player-debug-mode", "required", debugOn.length >= 3, debugOn.length ? `on for CSXS.${debugOn.join(", CSXS.")}` : "off", `Run: ${INSTALL}   (sets PlayerDebugMode=1 for CSXS 9-14 so AE loads the unsigned bridge)`);

// 5. Registered with Claude Code (optional: other MCP clients are configured by hand)
const claude = run("claude", ["mcp", "get", "after-effects"], true);
const registered = claude.code === 0 && claude.out.includes(path.join(ROOT, "server", "server.mjs").replace(/\\/g, WIN ? "\\" : "/"));
add("claude-code-registration", "recommended", registered, claude.code === 0 ? claude.out.split("\n").slice(0, 3).join(" | ") : "claude CLI not found or server not registered",
  `Run: claude mcp add after-effects -s user -- node "${path.join(ROOT, "server", "server.mjs")}"   (or ${INSTALL}). For other MCP clients see README "Other MCP clients".`);

// 6. Bridge has run inside AE (token file) and answers
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
add("bridge-config", "required", !!cfg, cfg ? `${CONFIG_FILE} (port ${cfg.port})` : `${CONFIG_FILE} not found`,
  "Start (or restart) After Effects once after installing. The bridge writes this file on its first start.");

const health = await new Promise((resolve) => {
  if (!cfg) return resolve({ ok: false, error: "no config" });
  const req = http.get({ host: "127.0.0.1", port: cfg.port, path: "/health", headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 3000 }, (res) => {
    let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { try { resolve(JSON.parse(t)); } catch { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); } });
  });
  req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "no answer in 3 s (AE busy rendering or showing a dialog?)" }); });
  req.on("error", (e) => resolve({ ok: false, error: e.code === "ECONNREFUSED" ? "nothing listening" : e.message }));
});
add("bridge-running", "required", !!health.ok, health.ok ? `bridge ${health.bridge} in ${health.app} ${health.appVersion}` : health.error,
  "Open After Effects. If it is open: Window > Extensions > Claude Bridge > Restart bridge. If the Extensions menu has no Claude Bridge, check cep-extension and player-debug-mode, then restart AE.");
if (health.ok) {
  const [maj, min] = String(health.bridge).split(".").map(Number);
  add("bridge-version", "recommended", maj > 1 || (maj === 1 && min >= 1), `bridge ${health.bridge}`, "Restart After Effects (or Window > Extensions > Claude Bridge > Restart bridge) to load the updated bridge.");
}

// 7. ffmpeg (optional: only for png_sequence renders encoded to .mp4)
const ff = run("ffmpeg", ["-version"]);
add("ffmpeg", "optional", ff.code === 0, ff.code === 0 ? ff.out.split("\n")[0] : "not on PATH", "Optional. Install ffmpeg and put it on PATH to turn png_sequence renders into .mp4 automatically.");

// Report
const failedRequired = checks.filter((c) => !c.ok && c.level === "required");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failedRequired.length === 0, configDir: CONFIG_DIR, checks }, null, 2));
} else {
  for (const c of checks) {
    const mark = c.ok ? "PASS" : c.level === "required" ? "FAIL" : "WARN";
    console.log(`${mark.padEnd(5)} ${c.name.padEnd(26)} ${c.detail}`);
    if (!c.ok) console.log(`      fix: ${c.fix}`);
  }
  console.log(failedRequired.length ? `\n${failedRequired.length} required check(s) failed.` : "\nAll required checks passed.");
}
process.exit(failedRequired.length ? 1 : 0);
