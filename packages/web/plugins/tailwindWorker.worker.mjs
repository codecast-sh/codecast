// Runs Tailwind for the dev server off Vite's main thread. See tailwindWorker.ts.
import { parentPort, workerData } from "node:worker_threads";
import postcss from "postcss";
import tailwindcss from "tailwindcss";

// One processor for the life of the worker, so Tailwind's per-stylesheet
// contexts (and their file mtime and candidate caches) stay warm between builds.
const processor = postcss([tailwindcss(workerData.configPath)]);

// Only plain-data messages survive postMessage; these are the ones Vite reads
// to watch Tailwind's content globs and its config.
const FORWARDED = new Set(["dependency", "dir-dependency"]);

parentPort.on("message", async ({ id, css, from }) => {
  try {
    const result = await processor.process(css, { from, to: from, map: false });
    for (const warning of result.warnings()) console.warn(warning.toString());
    parentPort.postMessage({
      id,
      css: result.css,
      messages: result.messages
        .filter((m) => FORWARDED.has(m.type))
        .map(({ type, file, dir, glob, parent, plugin }) => ({ type, file, dir, glob, parent, plugin })),
    });
  } catch (err) {
    parentPort.postMessage({
      id,
      error: { message: err?.message ?? String(err), stack: err?.stack, name: err?.name },
    });
  }
});
