// Keeps the backend's function log, which the self-hosted backend holds only in
// memory (about 70 seconds at production load), as hourly gzipped JSONL files:
// /logs/<YYYY-MM-DD>/<HH>.jsonl.gz, UTC, one `convex logs --jsonl` event per
// line. Files older than RETAIN_DAYS are deleted.
//
// A restart appends a new gzip member to the current hour's file, which zcat
// reads as one stream. The gzip is flushed every few seconds so a crash loses
// seconds of lines, not the hour.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

const ROOT = process.env.LOG_DIR ?? "/logs";
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS ?? 14);
const FLUSH_MS = 5_000;

let current = null; // { key, gz }

function fileFor(date) {
  const iso = date.toISOString();
  return { key: iso.slice(0, 13), file: path.join(ROOT, iso.slice(0, 10), `${iso.slice(11, 13)}.jsonl.gz`) };
}

function writer() {
  const { key, file } = fileFor(new Date());
  if (current?.key === key) return current.gz;
  current?.gz.end();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gz = zlib.createGzip();
  gz.pipe(fs.createWriteStream(file, { flags: "a" }));
  current = { key, gz };
  prune();
  return gz;
}

function prune() {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const day of fs.readdirSync(ROOT)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) fs.rmSync(path.join(ROOT, day), { recursive: true, force: true });
  }
}

setInterval(() => current?.gz.flush(), FLUSH_MS).unref();

// `convex logs` exits when its stream breaks (a backend restart, a network
// blip). Start it again with a growing delay, reset once it has run a while.
let backoff = 1_000;
function tail() {
  const started = Date.now();
  const child = spawn("convex", ["logs", "--jsonl", "--success"], { stdio: ["ignore", "pipe", "inherit"] });
  readline.createInterface({ input: child.stdout }).on("line", line => { if (line) writer().write(line + "\n"); });
  child.on("exit", code => {
    backoff = Date.now() - started > 60_000 ? 1_000 : Math.min(backoff * 2, 60_000);
    console.error(`${new Date().toISOString()} convex logs exited (${code}); restarting in ${backoff}ms`);
    setTimeout(tail, backoff);
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (!current) process.exit(0);
  current.gz.end(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
});

tail();
