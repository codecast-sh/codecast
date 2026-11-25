#!/usr/bin/env node
// zlib's async calls run on libuv's thread pool, four threads unless told
// otherwise. Size it to the machine before the first async call creates it, so
// every core compresses at once: one file at a time took 3m40s on Railway.
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
const THREADS = availableParallelism();
process.env.UV_THREADPOOL_SIZE ??= String(THREADS);
const { readdir, readFile, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { promisify } = await import("node:util");
const zlib = await import("node:zlib");
const { constants } = zlib;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const DIST = new URL("../dist/", import.meta.url).pathname;
const EXT = new Set([".js", ".css", ".html", ".svg", ".json", ".map", ".txt"]);
const MIN_BYTES = 1024;

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function shouldCompress(path) {
  if (path.endsWith(".br") || path.endsWith(".gz")) return false;
  const i = path.lastIndexOf(".");
  return i >= 0 && EXT.has(path.slice(i));
}

const files = (await walk(DIST)).filter(shouldCompress);
let kept = 0, total = 0, brBytes = 0, gzBytes = 0;
async function compress(f) {
  const buf = await readFile(f);
  if (buf.length < MIN_BYTES) return;
  const [br, gz] = await Promise.all([
    brotli(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }),
    gzip(buf, { level: 9 }),
  ]);
  await Promise.all([
    br.length < buf.length * 0.95 ? writeFile(`${f}.br`, br) : null,
    gz.length < buf.length * 0.95 ? writeFile(`${f}.gz`, gz) : null,
  ]);
  kept++;
  total += buf.length;
  brBytes += br.length;
  gzBytes += gz.length;
}
// Largest first, so one big file never starts last and runs alone.
const queue = files.map((f) => [f, statSync(f).size]).sort((a, b) => b[1] - a[1]).map(([f]) => f);
await Promise.all(
  Array.from({ length: THREADS }, async () => {
    for (let f; (f = queue.shift()); ) await compress(f);
  }),
);
console.log(
  `precompress: ${kept} files, raw=${(total / 1024).toFixed(0)} KiB → br=${(brBytes / 1024).toFixed(0)} KiB (${((1 - brBytes / total) * 100).toFixed(0)}%), gz=${(gzBytes / 1024).toFixed(0)} KiB (${((1 - gzBytes / total) * 100).toFixed(0)}%)`
);
