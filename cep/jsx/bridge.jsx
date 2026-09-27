// Claude AE Bridge, ExtendScript side.
// Loaded into After Effects' script engine by the bridge extension. ES3 only:
// no JSON object, no let/const, no arrow functions.

$.global.__claudeAE = (function () {
    var VERSION = "1.0.0";
    // Quotes, backslashes, control characters and the two Unicode line separators.
    var UNSAFE = new RegExp('[\\\\"\\x00-\\x1f' + String.fromCharCode(0x2028, 0x2029) + "]", "g");

    function quote(s) {
        return '"' + String(s).replace(UNSAFE, function (c) {
            if (c === '"') return '\\"';
            if (c === "\\") return "\\\\";
            if (c === "\n") return "\\n";
            if (c === "\r") return "\\r";
            if (c === "\t") return "\\t";
            var h = c.charCodeAt(0).toString(16);
            return "\\u" + "0000".substr(h.length) + h;
        }) + '"';
    }

    // AE objects (CompItem, Layer, Property...) are not plain data, so they are
    // reported as a short descriptor instead of being walked.
    function describe(v) {
        var d = {};
        try { d._type = v.reflect.name; } catch (e) { d._type = String(v); }
        try { if (v.id !== undefined) d.id = v.id; } catch (e) {}
        try { if (v.name !== undefined) d.name = v.name; } catch (e) {}
        try { if (v.index !== undefined) d.index = v.index; } catch (e) {}
        try { if (typeof v.fsName === "string") d.path = v.fsName; } catch (e) {}
        return d;
    }

    function stringify(v, depth) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return String(v);
        if (t === "string") return quote(v);
        if (t === "function") return "null";
        if (depth > 12) return quote("[depth limit]");
        if (v instanceof Array) {
            var a = [];
            for (var i = 0; i < v.length; i++) a.push(stringify(v[i], depth + 1));
            return "[" + a.join(",") + "]";
        }
        if (v instanceof Date) return quote(v.toUTCString());
        var plain = false;
        try { plain = v.constructor === Object; } catch (e) {}
        if (!plain) return stringify(describe(v), depth + 1);
        var parts = [];
        for (var k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
                parts.push(quote(k) + ":" + stringify(v[k], depth + 1));
            }
        }
        return "{" + parts.join(",") + "}";
    }

    // Runs a function body sent by the MCP server. The body gets `log` and
    // uses `return` for its result. Edits land in one named undo group.
    function run(__code, __undoName) {
        var __logs = [];
        var __grouped = false;
        var __out;
        function log() {
            var a = [];
            for (var i = 0; i < arguments.length; i++) {
                a.push(typeof arguments[i] === "string" ? arguments[i] : stringify(arguments[i], 0));
            }
            __logs.push(a.join(" "));
        }
        try {
            if (__undoName) { app.beginUndoGroup(__undoName); __grouped = true; }
            var __fn = eval("(function (log) {\n" + __code + "\n})");
            var __result = __fn(log);
            __out = '{"ok":true,"result":' + stringify(__result, 0) + ',"logs":' + stringify(__logs, 0) + "}";
        } catch (e) {
            var msg = (e && e.message !== undefined) ? (e.name + ": " + e.message) : String(e);
            var line = (e && typeof e.line === "number") ? e.line - 1 : null;
            __out = '{"ok":false,"error":' + quote(msg) + ',"line":' + stringify(line, 0) + ',"logs":' + stringify(__logs, 0) + "}";
        } finally {
            if (__grouped) { try { app.endUndoGroup(); } catch (e2) {} }
        }
        return __out;
    }

    return { version: VERSION, run: run, stringify: stringify };
})();
