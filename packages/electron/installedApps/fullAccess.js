// What an installed app with full access can do on the computer: files and
// programs, in plain Node. Both hosts run these in Codecast's main process
// (the macOS shim asks over the socket and gets the result back), so the caps
// below hold on every platform.
//
// The engine has already decided the call is allowed and its args are well
// formed; this module only does the work and keeps it bounded.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { isAbsolute, join } = require("node:path");
const { AppError } = require("./protocol");

const MB = 1024 * 1024;

/** `~` and `~/x` expand to the home folder; anything else must already be absolute. */
function resolvePath(p) {
  const expanded = p === "~" ? os.homedir() : p.startsWith("~/") ? join(os.homedir(), p.slice(2)) : p;
  if (!isAbsolute(expanded)) throw new AppError("bad-args", `not an absolute path: ${p}`);
  return expanded;
}

function typeOf(entry) {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return "other";
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function createFullAccess({
  maxReadBytes = 16 * MB,
  maxOutputBytes = 4 * MB,
  defaultTimeoutMs = 30_000,
  maxTimeoutMs = 10 * 60_000,
  maxWatches = 64,
} = {}) {
  const watches = new Map(); // slug -> Map(watchId -> FSWatcher)
  let nextWatch = 0;

  /**
   * Read through one fd, at most maxReadBytes + 1 bytes: a stat size can lie
   * (/dev/zero, /proc files report 0) and a file can grow after the check.
   * Opened non-blocking so a FIFO fails the regular-file check instead of
   * hanging the open.
   */
  async function readText(p) {
    const file = resolvePath(p);
    const fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    try {
      if (!(await fh.stat()).isFile()) throw new AppError("failed", `${file} is not a regular file`);
      const buf = Buffer.alloc(maxReadBytes + 1);
      let len = 0;
      while (len < buf.length) {
        const { bytesRead } = await fh.read(buf, len, buf.length - len, null);
        if (!bytesRead) break;
        len += bytesRead;
      }
      if (len > maxReadBytes) throw new AppError("failed", `${file} is larger than the ${maxReadBytes} byte limit`);
      return buf.toString("utf8", 0, len);
    } finally {
      await fh.close();
    }
  }

  async function writeText(p, text) {
    await fsp.writeFile(resolvePath(p), text, "utf8");
    return null;
  }

  async function list(p) {
    const entries = await fsp.readdir(resolvePath(p), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: typeOf(e) }));
  }

  async function stat(p) {
    const s = await fsp.lstat(resolvePath(p));
    return { type: typeOf(s), size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, mode: s.mode };
  }

  async function remove(p) {
    await fsp.rm(resolvePath(p), { recursive: true });
    return null;
  }

  /** Watch a path; `emit({watchId, type, path})` on each change. Returns the watch id. */
  function watch(slug, p, emit) {
    const target = resolvePath(p);
    const mine = watches.get(slug) || new Map();
    if (mine.size >= maxWatches) throw new AppError("failed", `an app can watch at most ${maxWatches} paths`);
    const watchId = `w${++nextWatch}`;
    const watcher = fs.watch(target, (type, name) => {
      emit({ watchId, type, path: name ? join(target, String(name)) : target });
    });
    watcher.on("error", (err) => {
      emit({ watchId, type: "error", path: target, message: err.message });
      unwatch(slug, watchId);
    });
    mine.set(watchId, watcher);
    watches.set(slug, mine);
    return watchId;
  }

  function unwatch(slug, watchId) {
    const mine = watches.get(slug);
    const watcher = mine && mine.get(watchId);
    if (!watcher) return false;
    watcher.close();
    mine.delete(watchId);
    return true;
  }

  /** Close every watch an app holds (its window closed or it was uninstalled). */
  function unwatchAll(slug) {
    for (const watcher of (watches.get(slug) || new Map()).values()) watcher.close();
    watches.delete(slug);
  }

  /**
   * Run a program directly (no shell). Resolves to
   * `{code, signal, stdout, stderr, timedOut, truncated}`; output past
   * maxOutputBytes per stream is dropped, and the program is killed at the
   * timeout.
   */
  function run(cmd, args = [], opts = {}) {
    const { cwd, env, timeoutMs } = opts || {};
    const limit = Math.min(timeoutMs || defaultTimeoutMs, maxTimeoutMs);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args || [], {
          cwd: cwd ? resolvePath(cwd) : undefined,
          env: { ...process.env, ...(env || {}) },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          // Its own process group on POSIX, so the timeout kills what it started too.
          detached: process.platform !== "win32",
        });
      } catch (err) {
        return reject(new AppError("failed", err.message));
      }
      const out = { stdout: [], stderr: [], size: { stdout: 0, stderr: 0 } };
      let truncated = false;
      let timedOut = false;
      for (const name of ["stdout", "stderr"]) {
        child[name].on("data", (chunk) => {
          const room = maxOutputBytes - out.size[name];
          if (room <= 0) return void (truncated = true);
          if (chunk.length > room) truncated = true;
          const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
          out[name].push(kept);
          out.size[name] += kept.length;
        });
      }
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: Buffer.concat(out.stdout).toString("utf8"),
          stderr: Buffer.concat(out.stderr).toString("utf8"),
          timedOut,
          truncated,
        });
      };
      // A grandchild can hold the pipes open after the program dies, so 'close'
      // may never come: kill the whole tree, drop the pipes and resolve now.
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, "SIGKILL");
      }, limit);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new AppError("failed", `${cmd}: ${err.message}`));
      });
      child.on("close", finish);
    });
  }

  return {
    "fs.readText": readText,
    "fs.writeText": writeText,
    "fs.list": list,
    "fs.stat": stat,
    "fs.remove": remove,
    "process.run": run,
    watch,
    unwatch,
    unwatchAll,
  };
}

module.exports = { createFullAccess, resolvePath };
