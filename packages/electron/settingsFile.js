// settings.json, read from memory and written whole.
//
// The shell asks for a setting on focus, blur and pointer paths (the dock, the
// call window, meeting detection, the shortcut table), and each ask used to be
// a synchronous read and parse of the file. Here a read costs one stat: the
// parsed object is kept and reused until the file's mtime or size moves, so an
// edit made by hand while the app runs is still picked up, and is never
// overwritten from a stale copy.
//
// A write goes to a sibling file and is renamed over the real one. The old
// in-place write, cut short by a crash or a full disk, left half a JSON
// document behind, which reads as `{}`: every window position, shortcut and
// permission grant gone at the next launch.
//
// Kept free of electron so it is unit-testable (settingsFile.test.js); main.js
// supplies the path.
const fs = require("node:fs");

function createSettingsFile(getPath, io = fs) {
  let cache = null; // { stamp, value }

  function stampOf(file) {
    try {
      const stat = io.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  function parse(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  /** The whole settings object; `{}` when the file is missing or unreadable. */
  function load() {
    const file = getPath();
    const stamp = stampOf(file);
    if (cache && cache.stamp === stamp) return cache.value;
    let value = {};
    if (stamp !== null) {
      try {
        value = parse(io.readFileSync(file, "utf8"));
      } catch {}
    }
    cache = { stamp, value };
    return value;
  }

  /** Merge `patch` over what is stored and replace the file in one rename. */
  function update(patch) {
    const file = getPath();
    const text = JSON.stringify({ ...load(), ...patch }, null, 2);
    const temp = `${file}.${process.pid}.tmp`;
    try {
      io.writeFileSync(temp, text);
      io.renameSync(temp, file);
    } catch (err) {
      try { io.unlinkSync(temp); } catch {}
      throw err;
    }
    // What a later read would parse, so memory and disk cannot disagree.
    cache = { stamp: stampOf(file), value: parse(text) };
  }

  return { load, update };
}

module.exports = { createSettingsFile };
