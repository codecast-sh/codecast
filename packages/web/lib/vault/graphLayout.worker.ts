// Layout worker: message adapter over `graphLayout.ts`. All the force
// simulation lives there so the main-thread fallback runs identical code.
//
// This is the app's first Web Worker. Vite bundles it from the
// `new Worker(new URL("./graphLayout.worker.ts", import.meta.url), {type: "module"})`
// call site in VaultGraphView — the URL must be a static literal for that to
// work, so don't refactor it into a variable.
//
// Every reply carries the `runId` it belongs to. The renderer starts a new run
// whenever the graph or filters change, and stale ticks from a superseded run
// are still in flight when that happens; tagging them is what keeps a
// cancelled layout from dragging nodes around under the new one.

import { runGraphLayout, type LayoutInput, type LayoutTick } from "./graphLayout";

export type LayoutRequest =
  | ({ type: "layout"; runId: number } & LayoutInput)
  | { type: "cancel" };

export type LayoutResponse = { type: "tick"; runId: number } & LayoutTick;

let cancelCurrent: (() => void) | null = null;

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;

  cancelCurrent?.();
  cancelCurrent = null;
  if (message.type !== "layout") return;

  // `positions` is the continuity seed: dropping it here made every worker-run
  // layout reshuffle from the circle instead of perturbing the on-screen
  // picture (review finding, R5).
  const { runId, nodes, edges, iterations, positions } = message;
  cancelCurrent = runGraphLayout({ nodes, edges, iterations, positions }, (tick) => {
    const response: LayoutResponse = { type: "tick", runId, ...tick };
    // Transfer the buffer rather than structured-cloning it: at 300 iterations
    // that's 20 posts per layout, and the renderer is the only reader.
    self.postMessage(response, { transfer: [tick.positions.buffer] });
    if (tick.done) cancelCurrent = null;
  });
};
