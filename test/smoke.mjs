// Drives server.mjs over stdio like an MCP client would.
// Usage: node test/smoke.mjs [tool] [json-args | @args.json]   (no tool: initialize, list tools, ae_status)

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = spawn(process.execPath, [path.join(here, "..", "server", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
const waiting = new Map();
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => waiting.set(id, resolve));
}

function show(label, msg) {
  const r = msg.result;
  if (r?.content) {
    const parts = r.content.map((c) => (c.type === "image" ? `[image ${c.mimeType}, ${Math.round((c.data.length * 3) / 4 / 1024)} KB]` : c.text));
    console.log(`--- ${label}${r.isError ? " (isError)" : ""}\n${parts.join("\n")}`);
  } else {
    console.log(`--- ${label}\n${JSON.stringify(msg.error || r, null, 2)}`);
  }
}

const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}`);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await request("tools/list", {});
console.log(`tools: ${list.result.tools.map((t) => t.name).join(", ")}`);

const [tool = "ae_status", rawArgs = "{}"] = process.argv.slice(2);
const args = JSON.parse(rawArgs.startsWith("@") ? fs.readFileSync(rawArgs.slice(1), "utf8") : rawArgs);
show(tool, await request("tools/call", { name: tool, arguments: args }));

server.stdin.end();
