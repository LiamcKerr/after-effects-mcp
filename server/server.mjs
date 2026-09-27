#!/usr/bin/env node
// After Effects MCP server. Speaks MCP (JSON-RPC over stdio) and forwards each
// tool call to the Claude Bridge extension running inside After Effects (../cep).
// No dependencies: Node 18+.

import fs from "node:fs";
import http from "node:http";
import readline from "node:readline";
import { TOOLS } from "./tools.mjs";
import { CONFIG_FILE } from "./paths.mjs";

const SERVER_INFO = { name: "after-effects", title: "After Effects", version: "1.1.0" };
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Controls the After Effects app open on this machine through the Claude Bridge extension. Start with ae_status. " +
  "Inspect before changing anything: ae_list_items and ae_comp_info return ids to reuse. Every change runs as one undo step " +
  "named \"Claude: ...\", so the user can reverse it with Edit > Undo. Check visual changes with ae_preview_frame. " +
  "ExtendScript is ES3, and alert/confirm/prompt or any dialog freezes AE until someone clicks. " +
  "For long renders use ae_render with format sequence and wait false, then poll ae_render_status every 30-60 s and report progress; AE answers nothing else while it renders.";

const NOT_RUNNING =
  "The After Effects bridge is not reachable. Check that After Effects is open. After a fresh install, restart AE once. " +
  "If it still fails, open Window > Extensions > Claude Bridge in AE and press Restart bridge. Run node scripts/doctor.mjs in the repo for a full check.";

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    throw new Error(NOT_RUNNING);
  }
}

// node:http rather than fetch: fetch gives up on any response slower than 300 s,
// which cut off long renders. Here the only timeout is ours.
function bridge(method, route, body, timeoutMs) {
  const cfg = readConfig();
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: cfg.port, path: route, method,
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        clearTimeout(timer);
        if (res.statusCode === 401) return reject(new Error("The bridge refused the token. Restart After Effects so both sides read the same bridge.json."));
        if (res.statusCode !== 200) return reject(new Error(`Bridge error ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`Unreadable bridge reply: ${text.slice(0, 300)}`)); }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`After Effects did not answer within ${Math.round(timeoutMs / 1000)} s. It may be rendering or showing a dialog; the script can still finish in AE.`));
    }, timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ECONNREFUSED") reject(new Error(NOT_RUNNING));
      else if (e.code === "ECONNRESET") reject(new Error("After Effects dropped the connection mid-call. It may have closed or crashed; check that it is still open."));
      else reject(new Error(`Bridge connection failed: ${e.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function scriptError(r) {
  const where = r.line != null ? ` (line ${r.line})` : "";
  const logs = r.logs && r.logs.length ? `\nlog:\n${r.logs.join("\n")}` : "";
  return new Error(`After Effects script error${where}: ${r.error}${logs}`);
}

const ctx = {
  health: () => bridge("GET", "/health", null, 5000),
  async run(code, { undo = "", label = "script", timeoutMs = 120000 } = {}) {
    const r = await bridge("POST", "/run", { code, undo, label }, timeoutMs);
    if (!r.ok) throw scriptError(r);
    return r;
  },
  // Starts a script without waiting for it (bridge 1.1+). AE runs it in the background;
  // poll with job(id). Anything else sent to AE queues behind it until it finishes.
  async start(code, { undo = "", label = "script", job } = {}) {
    const r = await bridge("POST", "/run", { code, undo, label, detach: true, job }, 10000);
    if (!r.ok) throw new Error(r.error || "The bridge could not start the job.");
    return r.job;
  },
  async job(id) {
    try {
      return await bridge("GET", `/jobs/${encodeURIComponent(id)}`, null, 5000);
    } catch (e) {
      if (/Bridge error 404/.test(e.message)) return { ok: false, status: "unknown" };
      throw e;
    }
  },
  scriptError,
};

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  try {
    return await tool.handler(args, ctx);
  } catch (e) {
    return { content: [{ type: "text", text: String(e.message || e) }], isError: true };
  }
}

async function route(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case "tools/call":
      return callTool(params.name, params.arguments || {});
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function dispatch(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  }
  // Notifications (initialized, cancelled) need no reply.
  if (msg.id === undefined || msg.id === null || typeof msg.method !== "string") return;
  try {
    send({ jsonrpc: "2.0", id: msg.id, result: await route(msg.method, msg.params || {}) });
  } catch (e) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: String(e.message || e) } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  dispatch(msg);
});
