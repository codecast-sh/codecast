#!/usr/bin/env bun
/**
 * Round trips of `cast computer` to the laptop from a cloud host, over one held
 * socket (docs/architecture/computer-remote.md):
 *
 *   bun scripts/computer-remote-bench.ts --on laptop --app com.apple.TextEdit [--n 20] [--element <name>]
 *   bun scripts/computer-remote-bench.ts --local --app com.apple.TextEdit     # the same verbs on this Mac, for the comparison
 *   ... --action set-value --element "text entry area"                        # a background window takes no click: time set-value
 *
 * Measures a read with no screenshot, a read with one, and a click on an
 * element (by index, resolved once). The app must already have a window; the
 * click target should be harmless (a text area). Nothing goes through argv per
 * call: a CLI start costs seconds and would bury the tunnel's share.
 */

import { parseArgs } from "node:util";
import { RemoteComputerClient } from "../src/computer/remoteClient.js";
import { ComputerClient } from "../src/computer/client.js";
import { resolveElement } from "../src/computer/tree.js";
import { sessionIdFromEnv } from "../src/sessionIdentity.js";
import type { ComputerClientLike } from "../src/computer/run.js";

const { values: o } = parseArgs({
  options: {
    on: { type: "string" }, local: { type: "boolean" }, app: { type: "string" },
    n: { type: "string", default: "20" }, element: { type: "string", default: "text" },
    action: { type: "string", default: "click" },
  },
});
if (!o.app || (!o.on && !o.local)) {
  console.error("usage: computer-remote-bench.ts (--on laptop | --local) --app <bundle id> [--n 20] [--element <name>]");
  process.exit(2);
}
const n = Number(o.n);
const client: ComputerClientLike = o.local ? new ComputerClient() : new RemoteComputerClient({ on: o.on!, session: sessionIdFromEnv() });

const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
async function time(label: string, f: () => Promise<unknown>): Promise<void> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await f();
    xs.push(performance.now() - t);
  }
  console.log(`${label.padEnd(28)} p50 ${pct(xs, 0.5).toFixed(0).padStart(5)} ms   p95 ${pct(xs, 0.95).toFixed(0).padStart(5)} ms   (n=${n})`);
}

try {
  const t0 = performance.now();
  const first = await client.getAppState({ app: o.app, noScreenshot: true });
  console.log(`${"first call (connect + read)".padEnd(28)} ${(performance.now() - t0).toFixed(0)} ms`);
  const index = resolveElement(first.snapshot.treeText, o.element!);
  await time("read, no screenshot", () => client.getAppState({ app: o.app, noScreenshot: true }));
  await time("read, with screenshot", () => client.getAppState({ app: o.app }));
  if (o.action === "set-value") {
    let i = 0;
    await time(`set-value #${index}`, () => client.action("setValue", { app: o.app, elementIndex: index, value: `bench ${i++}` }));
  } else await time(`click #${index}`, () => client.action("click", { app: o.app, elementIndex: index }));
} finally {
  client.shutdown();
}
