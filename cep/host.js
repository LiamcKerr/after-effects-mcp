// Claude AE Bridge, host side. Runs in an invisible CEP extension that AE
// starts on launch. Listens on 127.0.0.1 and hands each request to AE's
// script engine through evalScript, one at a time.
//
// Every request must carry the token from bridge.json in the config folder
// (Windows %APPDATA%\ClaudeAEBridge, macOS ~/Library/Application Support/ClaudeAEBridge).
// Requests with an Origin header (browsers) or a foreign Host header are refused.
// Startup steps and errors go to host.log in the same folder.
//
// Routes: GET /health, POST /run {code, undo, label[, detach, job]}, GET /jobs/<id>, POST /reload.
// A detached run answers at once with a job id; the script keeps running in AE and
// GET /jobs/<id> reports it (this is how long renders stay observable).

(function () {
  const BRIDGE_VERSION = "1.1.0";
  const DEFAULT_PORT = 47670;
  const MAX_BODY = 8 * 1024 * 1024;
  const RESTART_EVENT = "com.bitloop.claudebridge.restart";

  // Mixed-context CEP exposes require globally; otherwise Node sits under window.cep_node.
  const nodeRequire = typeof require === "function" ? require : window.cep_node && window.cep_node.require;
  if (typeof nodeRequire !== "function") throw new Error("Node.js is not available in this extension");
  const http = nodeRequire("http");
  const crypto = nodeRequire("crypto");
  const fs = nodeRequire("fs");
  const os = nodeRequire("os");
  const path = nodeRequire("path");
  const Buffer = nodeRequire("buffer").Buffer;

  const CONFIG_DIR = os.platform() === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ClaudeAEBridge")
    : path.join(os.homedir(), "Library", "Application Support", "ClaudeAEBridge");
  const CONFIG_FILE = path.join(CONFIG_DIR, "bridge.json");
  const LOG_FILE = path.join(CONFIG_DIR, "host.log");

  function log(msg) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      try { if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, ""); } catch (e) {}
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
    } catch (e) {}
  }

  const state = { status: "starting", port: null, error: null, started: new Date().toISOString(), requests: [] };
  window.__claudeBridgeState = state;
  window.addEventListener("error", (e) => log(`uncaught: ${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => log(`unhandled rejection: ${e.reason && e.reason.stack || e.reason}`));

  const cep = window.__adobe_cep__;
  const hostEnv = JSON.parse(cep.getHostEnvironment());
  let extensionDir = decodeURI(cep.getSystemPath("extension")).replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:/.test(extensionDir)) extensionDir = extensionDir.slice(1);
  const bridgeJsx = path.join(extensionDir, "jsx", "bridge.jsx").replace(/\\/g, "/");
  log(`start: bridge ${BRIDGE_VERSION}, ${hostEnv.appName} ${hostEnv.appVersion}, node ${typeof process !== "undefined" ? process.version : "?"}, extension ${extensionDir}`);

  function loadConfig() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) {}
    let changed = false;
    if (!cfg.token || typeof cfg.token !== "string" || cfg.token.length < 32) {
      cfg.token = crypto.randomBytes(32).toString("hex");
      changed = true;
    }
    if (!Number.isInteger(cfg.port)) { cfg.port = DEFAULT_PORT; changed = true; }
    if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    return cfg;
  }

  // evalScript calls are chained so a long render never interleaves with another call.
  let queue = Promise.resolve();
  function evalInAE(script) {
    const job = queue.then(() => new Promise((resolve) => cep.evalScript(script, resolve)));
    queue = job.catch(() => {});
    return job;
  }

  // JSON string literals are valid ExtendScript literals once U+2028/2029 are escaped.
  const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
  function literal(value) {
    return JSON.stringify(value).replace(LINE_SEPARATORS, (c) => "\\u" + c.charCodeAt(0).toString(16));
  }

  async function runInAE(code, undoName) {
    const script =
      `(function () {` +
      ` if (typeof __claudeAE === "undefined" || __claudeAE.version !== "1.0.0") $.evalFile(${literal(bridgeJsx)});` +
      ` return __claudeAE.run(${literal(code)}, ${literal(undoName || "")});` +
      ` })()`;
    const raw = await evalInAE(script);
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: `After Effects returned an unreadable reply: ${String(raw).slice(0, 500)}` };
    }
  }

  // Detached runs, newest last; the last 30 are kept.
  const jobs = new Map();
  function trackJob(id, entry) {
    jobs.set(id, entry);
    while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  }

  function remember(entry) {
    state.requests.unshift(entry);
    state.requests.length = Math.min(state.requests.length, 25);
  }

  function send(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  function authorised(req, token) {
    const got = Buffer.from(String(req.headers["authorization"] || ""));
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  function start() {
    const cfg = loadConfig();
    const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

    const server = http.createServer((req, res) => {
      if (req.headers.origin || !allowedHosts.has(String(req.headers.host || "").toLowerCase())) {
        return send(res, 403, { ok: false, error: "forbidden" });
      }
      if (!authorised(req, cfg.token)) return send(res, 401, { ok: false, error: "bad token" });

      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, {
          ok: true,
          bridge: BRIDGE_VERSION,
          app: hostEnv.appName,
          appVersion: hostEnv.appVersion,
          started: state.started,
          requests: state.requests,
        });
      }

      if (req.method === "POST" && req.url === "/run") {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY) { req.destroy(); return; }
          chunks.push(c);
        });
        req.on("end", async () => {
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) {
            return send(res, 400, { ok: false, error: "body must be JSON" });
          }
          if (typeof body.code !== "string") return send(res, 400, { ok: false, error: "code must be a string" });
          const t0 = Date.now();
          const label = String(body.label || "script").slice(0, 60);
          if (body.detach) {
            const id = String(body.job || `job-${t0.toString(36)}-${crypto.randomBytes(3).toString("hex")}`).slice(0, 80);
            trackJob(id, { ok: true, status: "running", label, started: new Date(t0).toISOString() });
            runInAE(body.code, body.undo).then((result) => {
              trackJob(id, { ok: true, status: result.ok ? "done" : "error", label, started: new Date(t0).toISOString(), ended: new Date().toISOString(), ms: Date.now() - t0, result });
              remember({ at: new Date().toISOString(), label: label + " (job)", ok: !!result.ok, ms: Date.now() - t0 });
            });
            return send(res, 200, { ok: true, job: id });
          }
          const result = await runInAE(body.code, body.undo);
          remember({ at: new Date().toISOString(), label, ok: !!result.ok, ms: Date.now() - t0 });
          send(res, 200, result);
        });
        return;
      }

      if (req.method === "GET" && req.url.indexOf("/jobs/") === 0) {
        const job = jobs.get(decodeURIComponent(req.url.slice(6)));
        return job ? send(res, 200, job) : send(res, 404, { ok: false, status: "unknown" });
      }

      // Reload this host page with fresh code from disk (after an update), no AE restart.
      if (req.method === "POST" && req.url === "/reload") {
        send(res, 200, { ok: true, reloading: true });
        log("reload requested over HTTP");
        setTimeout(() => { server.close(); window.location.reload(); }, 200);
        return;
      }

      send(res, 404, { ok: false, error: "not found" });
    });

    server.on("error", (e) => {
      state.status = "error";
      state.error = e.code === "EADDRINUSE"
        ? `Port ${cfg.port} is taken, probably by another open copy of After Effects.`
        : String(e.message || e);
      log(`server error: ${state.error}`);
    });

    server.listen(cfg.port, "127.0.0.1", () => {
      state.status = "listening";
      state.port = cfg.port;
      log(`listening on 127.0.0.1:${cfg.port}`);
    });

    // The status panel sends this to restart the host with fresh code.
    cep.addEventListener(RESTART_EVENT, () => {
      log("restart requested");
      server.close();
      cep.closeExtension();
    });
  }

  try {
    start();
  } catch (e) {
    state.status = "error";
    state.error = String(e && e.message || e);
    log(`start failed: ${e && e.stack || e}`);
  }
})();
