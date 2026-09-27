// Runs the real cep/host.js and cep/jsx/bridge.jsx in Node with a stand-in for
// After Effects, so the bridge plumbing can be tested without AE.
// Usage: node test/fake-ae.mjs   (Ctrl+C to stop)

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cepDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cep");
const require = createRequire(import.meta.url);

// Minimal ExtendScript world: $.global, $.evalFile and a tiny app object.
const undoLog = [];
const es = vm.createContext({});
vm.runInContext(`function CompItem() {}`, es);
Object.assign(es, {
  app: {
    version: "25.6.0x0 (fake)",
    beginUndoGroup: (n) => undoLog.push(`begin ${n}`),
    endUndoGroup: () => undoLog.push("end"),
    preferences: { getPrefAsLong: () => 0 },
    project: { file: null, numItems: 0, activeItem: null, renderQueue: { numItems: 0 }, rootFolder: { id: 0 } },
  },
});
es.$ = { global: es, evalFile: (p) => vm.runInContext(fs.readFileSync(p, "utf8"), es) };

const window = {
  addEventListener: () => {},
  __adobe_cep__: {
    addEventListener: () => {},
    closeExtension: () => console.log("fake AE: host asked to close"),
    getHostEnvironment: () => JSON.stringify({ appName: "AEFT", appVersion: "25.6 (fake)" }),
    getSystemPath: () => "file:///" + encodeURI(cepDir.replace(/\\/g, "/")),
    evalScript: (script, cb) => {
      let out;
      try { out = String(vm.runInContext(script, es)); } catch (e) { out = "EvalScript error."; }
      setTimeout(() => cb(out), 5);
    },
  },
};

const hostCtx = vm.createContext({ window, require, process, Buffer, console, setTimeout, setInterval, URL });
vm.runInContext(fs.readFileSync(path.join(cepDir, "host.js"), "utf8"), hostCtx, { filename: "host.js" });

setInterval(() => {
  const s = window.__claudeBridgeState;
  if (s && s.status !== "starting" && !s.announced) {
    s.announced = true;
    console.log(`fake AE bridge: ${s.status}${s.port ? ` on 127.0.0.1:${s.port}` : ""}${s.error ? ` (${s.error})` : ""}`);
  }
  if (undoLog.length) console.log(`undo: ${undoLog.splice(0).join(" | ")}`);
}, 200);
