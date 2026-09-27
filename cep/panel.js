// Claude Bridge status panel. The server itself lives in the invisible host
// extension; this panel wakes or restarts it and shows whether it answers.

(function () {
  const nodeRequire = typeof require === "function" ? require : window.cep_node && window.cep_node.require;
  const fs = nodeRequire("fs");
  const os = nodeRequire("os");
  const path = nodeRequire("path");
  const http = nodeRequire("http");

  const HOST_ID = "com.bitloop.claudebridge.host";
  const RESTART_EVENT = "com.bitloop.claudebridge.restart";
  const DIR = os.platform() === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ClaudeAEBridge")
    : path.join(os.homedir(), "Library", "Application Support", "ClaudeAEBridge");
  const CONFIG_FILE = path.join(DIR, "bridge.json");
  const LOG_FILE = path.join(DIR, "host.log");
  const cep = window.__adobe_cep__;
  const byId = (id) => document.getElementById(id);

  function restartHost() {
    const env = JSON.parse(cep.getHostEnvironment());
    cep.dispatchEvent({ type: RESTART_EVENT, scope: "APPLICATION", appId: env.appId, extensionId: "", data: "" });
    setTimeout(() => cep.requestOpenExtension(HOST_ID, ""), 1200);
  }

  function logTail(lines) {
    try { return fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-lines).join("\n"); } catch (e) { return "(no host log yet)"; }
  }

  function health() {
    return new Promise((resolve) => {
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) {
        return resolve({ ok: false, error: "No bridge config yet. The host has not started." });
      }
      const req = http.get(
        { host: "127.0.0.1", port: cfg.port, path: "/health", headers: { Authorization: `Bearer ${cfg.token}` }, timeout: 2000 },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            try { resolve(Object.assign(JSON.parse(text), { port: cfg.port })); } catch (e) { resolve({ ok: false, error: "Unreadable reply" }); }
          });
        }
      );
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "No answer within 2 s. AE may be busy (render or open dialog)." }); });
      req.on("error", () => resolve({ ok: false, error: `Nothing listening on port ${cfg.port}.` }));
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render(h) {
    byId("dot").className = "dot " + (h.ok ? "ok" : "bad");
    byId("status").textContent = h.ok ? "Bridge running" : "Bridge not reachable";
    byId("detail").textContent = h.ok
      ? `127.0.0.1:${h.port} · ${h.app} ${h.appVersion} · bridge ${h.bridge}`
      : `${h.error}\nPress Restart bridge. Host log:\n${logTail(4)}`;
    const calls = (h.requests || []).map((r) => {
      const time = new Date(r.at).toLocaleTimeString();
      return `<li><span class="${r.ok ? "" : "fail"}">${escapeHtml(r.label)}${r.ok ? "" : " (failed)"}</span><span>${time} · ${r.ms} ms</span></li>`;
    });
    byId("calls").innerHTML = calls.length ? calls.join("") : "<li><span>None yet</span><span></span></li>";
  }

  async function refresh() { render(await health()); }

  byId("start").addEventListener("click", () => {
    byId("status").textContent = "Restarting…";
    restartHost();
    setTimeout(refresh, 3000);
  });
  cep.requestOpenExtension(HOST_ID, "");
  setTimeout(refresh, 1000);
  setInterval(refresh, 5000);
})();
