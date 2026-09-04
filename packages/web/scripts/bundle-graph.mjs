import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";

const manifestPath = process.argv[2];
const entry = process.argv[3];
if (!manifestPath || !entry) {
  throw new Error("Usage: bun scripts/bundle-graph.mjs <manifest.json> <entry-key>");
}

const manifest = await Bun.file(manifestPath).json();
const root = resolve(dirname(manifestPath), "..");
const seen = new Set();
const visit = (key) => {
  if (seen.has(key)) return;
  const item = manifest[key];
  if (!item) throw new Error(`Manifest entry not found: ${key}`);
  seen.add(key);
  for (const dependency of item.imports ?? []) visit(dependency);
};
visit(entry);

const files = [];
for (const key of seen) {
  const item = manifest[key];
  for (const file of [item.file, ...(item.css ?? [])]) {
    if (!file) continue;
    const bytes = new Uint8Array(await Bun.file(resolve(root, file)).arrayBuffer());
    files.push({
      key,
      file,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 6 }).byteLength,
    });
  }
}
files.sort((a, b) => b.gzipBytes - a.gzipBytes);

console.log(JSON.stringify({
  manifest: manifestPath,
  entry,
  modules: seen.size,
  files: files.length,
  rawBytes: files.reduce((sum, file) => sum + file.rawBytes, 0),
  gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
  largest: files.slice(0, 20),
}, null, 2));
