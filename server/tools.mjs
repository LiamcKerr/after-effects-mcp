// Tool definitions for the After Effects MCP server. Each handler builds an
// ExtendScript function body (ES3) and runs it inside AE through the bridge.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { JOBS_DIR } from "./paths.mjs";

const FRAME_DIR = path.join(os.tmpdir(), "claude-ae-frames");
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

// JSON literals are valid ExtendScript once U+2028/2029 are escaped.
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
const lit = (v) => JSON.stringify(v === undefined ? null : v).replace(LINE_SEPARATORS, (c) => "\\u" + c.charCodeAt(0).toString(16));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

// Shared ExtendScript helpers, prepended to the canned tools (not to ae_run_script,
// so its error line numbers match the caller's script).
const HELPERS = `
function __findComp(ref) {
  if (ref === null || ref === "") {
    var a = app.project.activeItem;
    if (a && a instanceof CompItem) return a;
    throw new Error("No comp given and no comp is active. Open one in AE or pass comp (id or name).");
  }
  if (typeof ref === "number") {
    var byId = app.project.itemByID(ref);
    if (byId && byId instanceof CompItem) return byId;
    throw new Error("No comp with id " + ref);
  }
  var hits = [];
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem && it.name === ref) hits.push(it);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(hits.length + ' comps are named "' + ref + '". Pass the id instead.');
  throw new Error('No comp named "' + ref + '"');
}
function __r(v) {
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(__r(v[i])); return a; }
  return typeof v === "number" ? Math.round(v * 1000) / 1000 : v;
}
`;

const COMP_ARG = {
  anyOf: [{ type: "integer" }, { type: "string" }],
  description: "Comp id (from ae_list_items) or exact name. Omit to use the active comp.",
};

function compRef(args) {
  const c = args.comp;
  if (c === undefined || c === null || c === "") return null;
  if (typeof c === "number" || typeof c === "string") return c;
  throw new Error("comp must be an id or a name");
}

function pruneFrames() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const f of fs.readdirSync(FRAME_DIR)) {
      const p = path.join(FRAME_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

// saveFrameToPng writes the file after the call returns, so wait for a stable size.
async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < end) {
    try {
      const size = fs.statSync(file).size;
      if (size > 0 && size === last) return size;
      last = size;
    } catch {}
    await sleep(250);
  }
  throw new Error(`After Effects did not write the frame within ${timeoutMs / 1000} s.`);
}

// ── render jobs ─────────────────────────────────────────────────────────
// A record per render in JOBS_DIR, so ae_render_status works across sessions.
const jobFile = (id) => path.join(JOBS_DIR, `${id.replace(/[^\w.-]/g, "_")}.json`);
function saveJob(rec) { fs.mkdirSync(JOBS_DIR, { recursive: true }); fs.writeFileSync(jobFile(rec.job), JSON.stringify(rec, null, 2)); return rec; }
function loadJob(id) { try { return JSON.parse(fs.readFileSync(jobFile(id), "utf8")); } catch { return null; } }
function latestJob() {
  try {
    const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json")).map((f) => ({ f, t: fs.statSync(path.join(JOBS_DIR, f)).mtimeMs }));
    files.sort((a, b) => b.t - a.t);
    return files.length ? JSON.parse(fs.readFileSync(path.join(JOBS_DIR, files[0].f), "utf8")) : null;
  } catch { return null; }
}
// Frames written so far by a sequence render: files named <base>_<number>.<ext>.
function framesOnDisk(rec) {
  const re = new RegExp(`^${rec.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.${rec.ext || "png"}$`, "i");
  try {
    const hits = fs.readdirSync(rec.framesDir).map((f) => [f, re.exec(f)]).filter(([, m]) => m);
    const nums = hits.map(([, m]) => Number(m[1]));
    // Write times of the frames give the real pace (elapsed time also counts any stall before frame 1).
    const times = hits.map(([f]) => fs.statSync(path.join(rec.framesDir, f)).mtimeMs).sort((a, b) => a - b);
    return { count: nums.length, first: nums.length ? Math.min(...nums) : null, firstAt: times[0] || null, lastAt: times[times.length - 1] || null };
  } catch { return { count: 0, first: null }; }
}
function hasFfmpeg() { return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; }
function encodeMp4(rec) {
  const { count, first } = framesOnDisk(rec);
  if (!count) throw new Error(`No frames found in ${rec.framesDir}`);
  const pattern = path.join(rec.framesDir, `${rec.base}_%05d.${rec.ext || "png"}`);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-framerate", String(rec.fps), "-start_number", String(first), "-i", pattern,
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", rec.output], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").slice(0, 400)}`);
  return fs.statSync(rec.output).size;
}
function progressOf(rec) {
  const elapsed = (Date.now() - rec.started) / 1000;
  const out = { job: rec.job, comp: rec.comp, format: rec.format, frames: rec.frames, elapsedSeconds: Math.round(elapsed) };
  if (rec.format === "sequence") {
    const fr = framesOnDisk(rec), done = fr.count;
    out.framesDone = done;
    out.percent = rec.frames ? Math.min(100, Math.round((done / rec.frames) * 1000) / 10) : null;
    if (done > 0 && done < rec.frames) {
      const perFrame = done > 2 && fr.lastAt > fr.firstAt ? (fr.lastAt - fr.firstAt) / 1000 / (done - 1) : elapsed / done;
      out.secondsPerFrame = Math.round(perFrame * 100) / 100;
      out.etaSeconds = Math.round(perFrame * (rec.frames - done));
    }
  }
  return out;
}

export const TOOLS = [
  {
    name: "ae_status",
    title: "After Effects status",
    description: "Check the bridge to After Effects and summarise the open project: AE version, project file, unsaved changes, item count, active item, render queue size, and whether AE lets scripts write files. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async handler(args, ctx) {
      const health = await ctx.health();
      const r = await ctx.run(`
        var p = app.project, a = p.activeItem, sec = null, dirty = null;
        try { sec = app.preferences.getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY"); } catch (e) {}
        try { dirty = p.dirty; } catch (e) {}
        return {
          afterEffects: app.version,
          project: p.file ? p.file.fsName : "(unsaved project)",
          unsavedChanges: dirty,
          items: p.numItems,
          activeItem: a ? { id: a.id, name: a.name, type: a.typeName } : null,
          renderQueueItems: p.renderQueue.numItems,
          scriptsMayWriteFiles: sec === null ? null : sec === 1
        };`, { label: "status" });
      return json({ bridge: health.bridge, ...r.result });
    },
  },

  {
    name: "ae_list_items",
    title: "List project items",
    description: "List items in the After Effects project panel with their ids: comps (size, duration, fps, layer count), footage (file path, missing flag) and folders.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["all", "comp", "footage", "folder"], default: "all" },
        name_contains: { type: "string", description: "Case-insensitive name filter." },
        limit: { type: "integer", minimum: 1, maximum: 2000, default: 300 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(args, ctx) {
      const r = await ctx.run(`${HELPERS}
        var want = ${lit(args.kind || "all")}, needle = ${lit((args.name_contains || "").toLowerCase())}, limit = ${lit(args.limit || 300)};
        var rootId = app.project.rootFolder.id, out = [], total = 0;
        for (var i = 1; i <= app.project.numItems; i++) {
          var it = app.project.item(i);
          var kind = it instanceof CompItem ? "comp" : (it instanceof FolderItem ? "folder" : "footage");
          if (want !== "all" && kind !== want) continue;
          if (needle && it.name.toLowerCase().indexOf(needle) < 0) continue;
          total++;
          if (out.length >= limit) continue;
          var row = { id: it.id, name: it.name, kind: kind };
          if (it.parentFolder && it.parentFolder.id !== rootId) row.folder = it.parentFolder.name;
          if (kind === "comp") {
            row.size = [it.width, it.height]; row.duration = __r(it.duration); row.fps = __r(it.frameRate); row.layers = it.numLayers;
          } else if (kind === "folder") {
            row.items = it.numItems;
          } else {
            try { if (it.mainSource instanceof SolidSource) row.solid = true; } catch (e) {}
            try { if (it.mainSource instanceof FileSource && it.mainSource.file) row.file = it.mainSource.file.fsName; } catch (e) {}
            try { if (it.footageMissing) row.missing = true; } catch (e) {}
            if (it.width) row.size = [it.width, it.height];
            if (it.duration) row.duration = __r(it.duration);
          }
          out.push(row);
        }
        return { total: total, shown: out.length, items: out };`, { label: "list items" });
      return json(r.result);
    },
  },

  {
    name: "ae_comp_info",
    title: "Inspect a comp",
    description: "Describe a comp and its layers: settings, current time, work area, and per layer the index, name, kind, timing, switches, parent, source, effects, text content and transform values (with keyframe counts).",
    inputSchema: {
      type: "object",
      properties: {
        comp: COMP_ARG,
        layer_limit: { type: "integer", minimum: 1, maximum: 1000, default: 150 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(args, ctx) {
      const r = await ctx.run(`${HELPERS}
        var comp = __findComp(${lit(compRef(args))}), limit = ${lit(args.layer_limit || 150)};
        function kindOf(l) {
          if (l instanceof TextLayer) return "text";
          if (l instanceof ShapeLayer) return "shape";
          if (l instanceof CameraLayer) return "camera";
          if (l instanceof LightLayer) return "light";
          if (l.nullLayer) return "null";
          if (l.adjustmentLayer) return "adjustment";
          if (l.source instanceof CompItem) return "precomp";
          try { if (l.source.mainSource instanceof SolidSource) return "solid"; } catch (e) {}
          return "footage";
        }
        var TRANSFORM = [["anchor", "ADBE Anchor Point"], ["position", "ADBE Position"], ["scale", "ADBE Scale"], ["rotation", "ADBE Rotate Z"], ["opacity", "ADBE Opacity"]];
        var layers = [], selected = [];
        for (var i = 1; i <= comp.numLayers && layers.length < limit; i++) {
          var l = comp.layer(i), k = kindOf(l);
          var row = { index: i, name: l.name, kind: k, inPoint: __r(l.inPoint), outPoint: __r(l.outPoint), startTime: __r(l.startTime) };
          if (!l.enabled) row.enabled = false;
          if (l.solo) row.solo = true;
          if (l.locked) row.locked = true;
          if (l.shy) row.shy = true;
          if (l.selected) { row.selected = true; selected.push(i); }
          try { if (l.threeDLayer) row.threeD = true; } catch (e) {}
          if (l.parent) row.parent = l.parent.index;
          try { if (l.source) row.source = { id: l.source.id, name: l.source.name }; } catch (e) {}
          if (k === "text") { try { row.text = l.property("ADBE Text Properties").property("ADBE Text Document").value.text; } catch (e) {} }
          try {
            var fx = l.property("ADBE Effect Parade"), names = [];
            for (var j = 1; j <= fx.numProperties; j++) names.push(fx.property(j).name);
            if (names.length) row.effects = names;
          } catch (e) {}
          var tf = {}, keyed = {};
          for (var t = 0; t < TRANSFORM.length; t++) {
            try {
              var p = l.property("ADBE Transform Group").property(TRANSFORM[t][1]);
              if (!p) continue;
              tf[TRANSFORM[t][0]] = __r(p.value);
              if (p.numKeys > 0) keyed[TRANSFORM[t][0]] = p.numKeys;
            } catch (e) {}
          }
          row.transform = tf;
          for (var kk in keyed) { row.keyframes = keyed; break; }
          layers.push(row);
        }
        return {
          id: comp.id, name: comp.name, size: [comp.width, comp.height], pixelAspect: comp.pixelAspect,
          duration: __r(comp.duration), fps: __r(comp.frameRate), time: __r(comp.time),
          workArea: [__r(comp.workAreaStart), __r(comp.workAreaDuration)], background: __r(comp.bgColor),
          numLayers: comp.numLayers, shown: layers.length, selectedLayers: selected, layers: layers
        };`, { label: "comp info" });
      return json(r.result);
    },
  },

  {
    name: "ae_preview_frame",
    title: "Preview a frame",
    description: "Render one frame of a comp to PNG and return it as an image so you can see the result. Uses the comp's current time unless time (seconds) is given.",
    inputSchema: {
      type: "object",
      properties: {
        comp: COMP_ARG,
        time: { type: "number", minimum: 0, description: "Seconds from the start of the comp." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(args, ctx) {
      if (args.time !== undefined && typeof args.time !== "number") throw new Error("time must be a number of seconds");
      fs.mkdirSync(FRAME_DIR, { recursive: true });
      pruneFrames();
      const file = path.join(FRAME_DIR, `frame-${Date.now()}.png`);
      const r = await ctx.run(`${HELPERS}
        var comp = __findComp(${lit(compRef(args))});
        var t = ${args.time === undefined ? "comp.time" : lit(args.time)};
        if (t < 0 || t > comp.duration) throw new Error("time " + t + " is outside the comp (0 to " + comp.duration + " s)");
        if (typeof comp.saveFrameToPng !== "function") throw new Error("This version of After Effects has no saveFrameToPng.");
        comp.saveFrameToPng(t, new File(${lit(file.replace(/\\/g, "/"))}));
        return { comp: comp.name, id: comp.id, time: __r(t), size: [comp.width, comp.height] };`, { label: "preview frame" });
      const bytes = await waitForFile(file, 30000);
      const meta = { ...r.result, file };
      if (bytes > MAX_IMAGE_BYTES) {
        return json({ ...meta, note: `The PNG is ${(bytes / 1048576).toFixed(1)} MB, too large to return inline. Open the file instead.` });
      }
      return {
        content: [
          { type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify(meta, null, 2) },
        ],
      };
    },
  },

  {
    name: "ae_import",
    title: "Import a file",
    description: "Import a file (footage, image, audio, image sequence, AE project) into the project, optionally into a named folder (created if missing). Returns the new item's id.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file." },
        folder: { type: "string", description: "Project panel folder name to put it in." },
        sequence: { type: "boolean", default: false, description: "Import numbered stills as one image sequence." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (typeof args.path !== "string" || !path.isAbsolute(args.path)) throw new Error("path must be an absolute file path");
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`);
      const r = await ctx.run(`${HELPERS}
        var io = new ImportOptions(new File(${lit(args.path.replace(/\\/g, "/"))}));
        if (${lit(!!args.sequence)}) io.sequence = true;
        var item = app.project.importFile(io);
        var folderName = ${lit(args.folder || "")};
        if (folderName) {
          var folder = null;
          for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === folderName) { folder = it; break; }
          }
          if (!folder) folder = app.project.items.addFolder(folderName);
          item.parentFolder = folder;
        }
        return { id: item.id, name: item.name, type: item.typeName, size: item.width ? [item.width, item.height] : null, duration: item.duration ? __r(item.duration) : null };`,
        { undo: "Claude: import", label: "import" });
      return json(r.result);
    },
  },

  {
    name: "ae_render",
    title: "Render a comp",
    description:
      "Render a comp through AE's render queue. Only this comp renders; other queued items are paused and restored. " +
      "format \"template\" (default) writes one file with the output module template (AE 2026's default writes H.264 .mp4); AE shows no progress until it finishes. " +
      "format \"sequence\" writes numbered frames (default template \"TIFF Sequence with Alpha\"; AE ships no PNG template) to <output_path without extension>_frames/ so progress can be watched, then, if output_path ends in .mp4 and ffmpeg is on PATH, encodes them to output_path (video only, no audio). " +
      "wait true (default) blocks until done. wait false returns a job id at once: poll ae_render_status every 30-60 s. While a render runs, AE answers nothing else; only ae_render_status works. " +
      "Output module and render settings take AE template names; an unknown name returns the available ones.",
    inputSchema: {
      type: "object",
      properties: {
        output_path: { type: "string", description: "Absolute output file path (e.g. .mp4). For sequence the frames go to a sibling folder <name>_frames/." },
        comp: COMP_ARG,
        format: { type: "string", enum: ["template", "sequence", "png_sequence"], default: "template", description: "\"sequence\" renders numbered frames with progress (\"png_sequence\" is an alias)." },
        wait: { type: "boolean", default: true, description: "false: start the render and return a job id for ae_render_status." },
        output_module: { type: "string", description: "Output module template. template: e.g. \"H.264 - Match Render Settings - 15 Mbps\" or \"Lossless\" (default: AE's default). sequence: an image-sequence template (default \"TIFF Sequence with Alpha\"; a custom PNG template works too)." },
        render_settings: { type: "string", description: "Render settings template, e.g. \"Best Settings\". Default: AE's default." },
        span: { type: "string", enum: ["work_area", "comp"], default: "work_area" },
        encode: { type: "boolean", default: true, description: "sequence only: encode the frames to output_path with ffmpeg when done (if output_path ends in .mp4)." },
        overwrite: { type: "boolean", default: false },
        timeout_minutes: { type: "number", minimum: 1, maximum: 600, default: 60, description: "wait true only." },
      },
      required: ["output_path"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const out = args.output_path;
      if (typeof out !== "string" || !path.isAbsolute(out)) throw new Error("output_path must be an absolute file path");
      const png = args.format === "sequence" || args.format === "png_sequence";      // `png`: any image sequence
      const seqTemplate = png ? args.output_module || "TIFF Sequence with Alpha" : null;
      const ext = !png ? null : /png/i.test(seqTemplate) ? "png" : /tiff/i.test(seqTemplate) ? "tif" : /photoshop|multi-machine/i.test(seqTemplate) ? "psd" : /jpe?g/i.test(seqTemplate) ? "jpg" : "tif";
      const base = path.basename(out, path.extname(out));
      const framesDir = png ? path.join(path.dirname(out), `${base}_frames`) : null;
      if (png) {
        const existing = fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter((f) => /\.(png|tiff?|psd|jpe?g)$/i.test(f)) : [];
        if (existing.length && !args.overwrite) throw new Error(`${framesDir} already holds ${existing.length} frames. Pass overwrite: true to replace them.`);
        for (const f of existing) fs.unlinkSync(path.join(framesDir, f));
        fs.mkdirSync(framesDir, { recursive: true });
      } else {
        if (fs.existsSync(out) && !args.overwrite) throw new Error(`${out} already exists. Pass overwrite: true to replace it.`);
        // AE asks "already exists. Overwrite?" in a modal dialog, which blocks the bridge. Remove it first.
        if (fs.existsSync(out)) fs.unlinkSync(out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
      }
      const span = args.span || "work_area";

      // 1. Plan (quick): how many frames, at what rate.
      const plan = (await ctx.run(`${HELPERS}
        var comp = __findComp(${lit(compRef(args))});
        var s0 = ${lit(span)} === "comp" ? 0 : comp.workAreaStart, d = ${lit(span)} === "comp" ? comp.duration : comp.workAreaDuration;
        return { comp: comp.name, id: comp.id, fps: comp.frameRate, start: s0, duration: d, frames: Math.round(d * comp.frameRate) };`, { label: "render plan" })).result;

      // 2. The render script: queue the comp, set output, pause other items, render, restore.
      const target = png ? path.join(framesDir, `${base}_[#####].${ext}`) : out;
      const script = `${HELPERS}
        var comp = __findComp(${lit(plan.id)});
        var rq = app.project.renderQueue;
        var item = rq.items.add(comp), mine = rq.numItems, om = item.outputModule(1);
        function pick(names, want, what) {
          var shown = [];
          for (var i = 0; i < names.length; i++) {
            if (names[i] === want) return;
            if (names[i].indexOf("_HIDDEN") !== 0) shown.push(names[i]);
          }
          throw new Error("No " + what + ' template "' + want + '". Available: ' + shown.join(", "));
        }
        try {
          var rs = ${lit(args.render_settings || "")}, omName = ${lit(png ? seqTemplate : args.output_module || "")};
          if (rs) { pick(item.templates, rs, "render settings"); item.applyTemplate(rs); }
          if (omName) { pick(om.templates, omName, "output module"); om.applyTemplate(omName); }
          // The span comes from the comp itself: a duration sent through JSON can round a hair past
          // the comp end, and AE then stops on a modal "frames outside of range" warning.
          if (${lit(span)} === "comp") { item.timeSpanStart = 0; item.timeSpanDuration = comp.duration; }
          else { item.timeSpanStart = comp.workAreaStart; item.timeSpanDuration = comp.workAreaDuration; }
          om.file = new File(${lit(target.replace(/\\/g, "/"))});
        } catch (e) { item.remove(); throw e; }
        var paused = [];
        for (var j = 1; j <= rq.numItems; j++) {
          var other = rq.item(j);
          if (j !== mine && other.status === RQItemStatus.QUEUED) { other.render = false; paused.push(other); }
        }
        var t0 = new Date().getTime();
        // Any warning AE raises mid-render would sit in a modal dialog and freeze the bridge.
        app.beginSuppressDialogs();
        try { rq.render(); } finally { app.endSuppressDialogs(false); for (var k = 0; k < paused.length; k++) paused[k].render = true; }
        var s = item.status, names = { DONE: RQItemStatus.DONE, ERR_STOPPED: RQItemStatus.ERR_STOPPED, USER_STOPPED: RQItemStatus.USER_STOPPED, NEEDS_OUTPUT: RQItemStatus.NEEDS_OUTPUT };
        var status = "OTHER";
        for (var n in names) if (names[n] === s) status = n;
        var file = om.file ? om.file.fsName : null;
        if (status === "DONE") item.remove();
        return { comp: comp.name, status: status, file: file, seconds: Math.round((new Date().getTime() - t0) / 100) / 10 };`;
      // No undo group: rendering inside one makes AE raise a modal "Undo group mismatch"
      // warning, which blocks every later script until someone clicks OK.

      const rec = saveJob({ job: `render-${Date.now().toString(36)}`, comp: plan.comp, format: png ? "sequence" : "template", output: out, framesDir, base, ext,
        frames: plan.frames, fps: plan.fps, started: Date.now(), encode: png && args.encode !== false && /\.mp4$/i.test(out), status: "running" });

      if (args.wait === false) {
        await ctx.start(script, { label: `render ${plan.comp}`, job: rec.job });
        return json({ job: rec.job, status: "running", comp: plan.comp, frames: plan.frames, format: rec.format,
          next: "Poll ae_render_status with this job every 30-60 s. AE answers nothing else until the render ends." });
      }
      const r = await ctx.run(script, { label: "render", timeoutMs: (args.timeout_minutes || 60) * 60000 });
      const result = { job: rec.job, ...r.result };
      if (result.status === "DONE" && rec.encode) {
        if (hasFfmpeg()) { result.encodedBytes = encodeMp4(rec); result.file = out; rec.encoded = true; }
        else result.note = `Frames are in ${framesDir}. ffmpeg is not on PATH, so no .mp4 was made.`;
      }
      if (png) result.framesDir = framesDir;
      else if (result.file && fs.existsSync(result.file)) result.bytes = fs.statSync(result.file).size;
      saveJob({ ...rec, status: result.status === "DONE" ? "done" : "error", ended: Date.now(), result });
      if (result.status !== "DONE") return { ...json(result), isError: true };
      return json(result);
    },
  },

  {
    name: "ae_render_status",
    title: "Render progress",
    description:
      "Progress of a render started by ae_render: status (running, done, error), and for sequence renders frames done, percent, seconds per frame and ETA. " +
      "Works while AE is busy rendering. When a sequence render with encode is done, this call encodes the .mp4 (ffmpeg) and reports it. Omit job for the latest render.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string", description: "Job id from ae_render. Omit for the most recent render." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(args, ctx) {
      const rec = args.job ? loadJob(args.job) : latestJob();
      if (!rec) throw new Error(args.job ? `No render job ${args.job}` : "No render jobs yet.");
      const out = progressOf(rec);
      if (rec.status === "running") {
        const host = await ctx.job(rec.job).catch(() => ({ status: "unknown" }));
        if (host.status === "done" || host.status === "error") {
          const res = host.result || {};
          rec.status = host.status === "done" && res.ok !== false && (!res.result || res.result.status === "DONE") ? "done" : "error";
          rec.ended = Date.now();
          rec.result = res.ok === false ? { error: res.error } : res.result;
          saveJob(rec);
        } else if (host.status === "unknown" && rec.format === "sequence" && out.framesDone >= rec.frames) {
          rec.status = "done"; rec.ended = Date.now(); saveJob(rec);       // bridge restarted since; the frames say it finished
        }
      }
      out.status = rec.status;
      if (rec.result) out.result = rec.result;
      if (rec.status === "done" && rec.encode && !rec.encoded) {
        if (hasFfmpeg()) { out.encodedBytes = encodeMp4(rec); rec.encoded = true; saveJob(rec); }
        else out.note = `Frames are in ${rec.framesDir}. ffmpeg is not on PATH, so no .mp4 was made.`;
      }
      if (rec.encoded) out.file = rec.output;
      if (rec.status === "running") out.next = "Still rendering. Check again in 30-60 s.";
      return json(out);
    },
  },

  {
    name: "ae_run_script",
    title: "Run ExtendScript",
    description:
      "Run ExtendScript inside After Effects and return the result. The script is the body of a function: `return` a value to send it back (plain objects, arrays, numbers and strings come back as JSON; AE objects come back as {_type, id, name, index}). Call log(...) to collect messages. " +
      "ES3 only: var and function, no JSON object, no let/const, arrow functions or template strings, and reserved words (in, class, default…) must be quoted as object keys. Never call alert, confirm or prompt, or anything that opens a dialog: it freezes AE and the bridge until someone clicks. " +
      "All edits land in one undo step named undo_name. Entry points: app.project, app.project.activeItem, app.project.itemByID(id), comp.layer(index or name), comp.layers.addText/addSolid/addNull/addShape, " +
      "layer.property('ADBE Transform Group').property('ADBE Position'), layer.property('ADBE Effect Parade').addProperty(matchName), prop.setValueAtTime(t, v), app.project.save().",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "ExtendScript function body." },
        undo_name: { type: "string", description: "Name of the undo step. Default \"Claude: script\"." },
        timeout_seconds: { type: "number", minimum: 1, maximum: 3600, default: 120 },
      },
      required: ["script"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    async handler(args, ctx) {
      if (typeof args.script !== "string" || !args.script.trim()) throw new Error("script must be a non-empty string");
      const r = await ctx.run(args.script, {
        undo: args.undo_name || "Claude: script",
        label: args.undo_name || "script",
        timeoutMs: (args.timeout_seconds || 120) * 1000,
      });
      return json(r.logs && r.logs.length ? { result: r.result, logs: r.logs } : { result: r.result });
    },
  },
];
