// A command station that takes a place in one of this machine's named slots before its script runs (machine_slot=,
// machineSlot.ts). Every Ship runs on the asking machine's daemon, and two Local CI runs side by side already fill a
// laptop: a third, or one started while the machine is short of memory, waits outside the station. Its timeout is the
// longest it waits, and its clock starts only once it holds a place, so the wait spends none of the script's time. No
// place by then is the outcome `no_slot`, which the flow routes like any other (Codecast's change flow sends it on to
// the pull request, where CI judges the change).
import { takeMachineSlot } from "../machineSlot.js";
import { c } from "../colors.js";
import { recordNodeOutput } from "./commandStation";
import type { NodeOutcome, WorkflowNode } from "./types";

export const NO_SLOT = "no_slot";

const span = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`);

/** Run `run` once `node` holds a place in its machine slot; a node without one runs at once. `what` names the holder in listings. */
export async function withStationSlot(node: WorkflowNode, context: Record<string, string>, run: () => Promise<NodeOutcome>, what?: string): Promise<NodeOutcome> {
  if (!node.machine_slot) return run();
  const waitMs = (node.timeout ?? 120) * 1000;
  const slot = await takeMachineSlot(node.machine_slot, {
    waitMs,
    what: what ?? node.label,
    onWait: (why) => console.log(`  ${c.dim}waiting to run ${node.label}: ${why}; the station's clock starts when it runs (up to ${span(waitMs)})${c.reset}`),
  });
  if (!slot.release) {
    const words = `${node.label} did not run: ${slot.why} for ${span(waitMs)} (${NO_SLOT}).`;
    console.log(`  ${c.yellow}! ${words}${c.reset}`);
    recordNodeOutput(context, node.id, words);
    // An exit code left by an earlier visit must not route this one.
    delete context[`${node.id}.exit_code`];
    return NO_SLOT;
  }
  try {
    return await run();
  } finally {
    slot.release();
  }
}
