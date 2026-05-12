#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

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
for (const f of files) {
  const buf = await readFile(f);
  if (buf.length < MIN_BYTES) continue;
  const br = brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
  const gz = gzipSync(buf, { level: 9 });
  if (br.length < buf.length * 0.95) await writeFile(`${f}.br`, br);
  if (gz.length < buf.length * 0.95) await writeFile(`${f}.gz`, gz);
  kept++;
  total += buf.length;
  brBytes += br.length;
  gzBytes += gz.length;
}
console.log(
  `precompress: ${kept} files, raw=${(total / 1024).toFixed(0)} KiB → br=${(brBytes / 1024).toFixed(0)} KiB (${((1 - brBytes / total) * 100).toFixed(0)}%), gz=${(gzBytes / 1024).toFixed(0)} KiB (${((1 - gzBytes / total) * 100).toFixed(0)}%)`
);
