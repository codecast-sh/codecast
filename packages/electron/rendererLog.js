// Warnings and errors from the app's own windows, kept on disk.
//
// The renderer console is otherwise gone the moment a window reloads. On
// 2026-11-13 the local cache was wiped and refilled under a running app, and
// the lines that would have named the cause (the storage watchdog's errors,
// the cache's own records) existed only in a console nobody had open, so the
// incident had to be reconstructed from Chromium's leveldb LOG.
//
// Only pages on the app's own origin are logged: a browser pane shows other
// people's sites, and their console is none of ours. Info and debug lines are
// dropped (they are the bulk); warnings and errors are kept in a file that
// rotates at MAX_BYTES, one previous generation kept beside it.
const fs = require("fs");
const path = require("path");

const MAX_BYTES = 5 * 1024 * 1024;
const KEPT_LEVELS = new Set(["warning", "error"]);
// Electron before 35 passed (event, level, message, line, sourceId) with a
// numeric level; later versions pass one details object.
const NUMERIC_LEVELS = ["verbose", "info", "warning", "error"];

// `dir` may be a function: it is resolved at the first write, not at startup.
function createRendererLog({ dir, appOrigin, fsImpl = fs, now = () => new Date(), maxBytes = MAX_BYTES }) {
  let resolved = null;
  const where = () => {
    if (resolved === null) {
      const d = typeof dir === "function" ? dir() : dir;
      resolved = { dir: d, file: path.join(d, "renderer.log") };
    }
    return resolved;
  };
  let size = null;

  function append(line) {
    try {
      const { dir, file } = where();
      if (size === null) {
        fsImpl.mkdirSync(dir, { recursive: true });
        try { size = fsImpl.statSync(file).size; } catch { size = 0; }
      }
      if (size + Buffer.byteLength(line) > maxBytes) {
        try { fsImpl.renameSync(file, `${file}.1`); } catch {}
        size = 0;
      }
      fsImpl.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // A log that cannot be written never takes a window down with it.
    }
  }

  function record(contents, args) {
    const details = args[0] && typeof args[0] === "object" && "message" in args[0] ? args[0] : null;
    const level = details ? details.level : NUMERIC_LEVELS[args[1]] ?? String(args[1]);
    if (!KEPT_LEVELS.has(level)) return;
    let url;
    try { url = new URL(contents.getURL()); } catch { return; }
    if (url.origin !== appOrigin()) return;
    const message = String(details ? details.message : args[2]).replace(/\n/g, "\n    ");
    const source = details ? details.sourceId : args[4];
    const line = details ? details.lineNumber : args[3];
    const at = source ? ` (${String(source).split("/").pop()}:${line})` : "";
    append(`${now().toISOString()} ${level.toUpperCase()} [${url.pathname}] ${message}${at}\n`);
  }

  return {
    /** The log file's path (resolves the directory). */
    file: () => where().file,
    /** Start keeping this web contents' warnings and errors. */
    attach(contents) {
      contents.on("console-message", (...args) => record(contents, args));
    },
  };
}

module.exports = { createRendererLog, MAX_BYTES };
