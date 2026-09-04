import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { SourceMapConsumer } from "source-map";

const profilePath = process.argv[2];
const dist = process.argv[3];
if (!profilePath || !dist) {
  throw new Error("Usage: bun scripts/cdp-cpu-summary.mjs <profile.json> <dist>");
}

const profile = JSON.parse(await readFile(profilePath, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const consumers = new Map();
const compactSource = (source) => {
  const web = source.lastIndexOf("/packages/web/");
  if (web >= 0) return source.slice(web + 1);
  const modules = source.lastIndexOf("/node_modules/");
  if (modules >= 0) return source.slice(modules + 1);
  return source || "(runtime)";
};
const consumerFor = async (url) => {
  if (!url) return null;
  const file = basename(new URL(url).pathname);
  if (consumers.has(file)) return consumers.get(file);
  const promise = readFile(join(dist, "assets", `${file}.map`), "utf8")
    .then((source) => new SourceMapConsumer(JSON.parse(source)))
    .catch(() => null);
  consumers.set(file, promise);
  return promise;
};

const totals = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  const frame = nodes.get(profile.samples[index])?.callFrame;
  if (!frame) continue;
  const consumer = await consumerFor(frame.url);
  const original = frame.lineNumber >= 0 && frame.columnNumber >= 0
    ? consumer?.originalPositionFor({
        line: frame.lineNumber + 1,
        column: frame.columnNumber,
      })
    : null;
  const source = compactSource(original?.source ?? frame.url ?? "(runtime)");
  const line = original?.line ?? frame.lineNumber + 1;
  const name = original?.name ?? (frame.functionName || "(anonymous)");
  const key = `${source}:${line}:${name}`;
  totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index] / 1000);
}

for (const consumer of await Promise.all(consumers.values())) consumer?.destroy?.();
const top = [...totals]
  .map(([frame, selfMs]) => ({ frame, selfMs: Number(selfMs.toFixed(1)) }))
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 40);
console.log(JSON.stringify({ profile: profilePath, samples: profile.samples.length, top }, null, 2));
