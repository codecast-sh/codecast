// The words that replay a sim run: the --order value and the replay lines a
// failure prints (docs/architecture/multiplayer-sim-harness.md section 3.9).
//
// A leaf with no runtime imports, so every party builds the same lines from
// one place: report.ts and scripts/sim.ts here, and the eval tool's api child
// (packages/evals/src/api/simHistory.ts), which cannot load report.ts (it
// imports the convex payload denylist) or net.ts (it imports the store).
import type { Channel } from "./net";

/** The --order replay line: channels separated by spaces (channel names hold no whitespace). */
export function formatOrder(channels: readonly Channel[]): string {
  return channels.join(" ");
}

/** Reads a --order / SIM_ORDER value; accepts spaces or commas between channels. */
export function parseOrder(s: string): Channel[] {
  return s.split(/[\s,]+/).filter(Boolean);
}

const SHELL_SAFE = /^[\w:/.@%+=,-][\w:/.@%+=,#-]*$/;
const shellWord = (s: string) => (SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// Inside double quotes the shell still expands `$`, backticks and `\`, so the
// order (read back from result.json, never trusted) keeps its double-quoted
// form only when it holds none of them; otherwise the whole word is single-quoted.
const DQ_SAFE = /^[^$`"\\!\n]*$/;
const orderWord = (order: string) => (DQ_SAFE.test(order) ? `--order="${order}"` : shellWord(`--order=${order}`));

/**
 * The lines that replay a failure, from plain facts as result.json holds
 * them: the trace (with the row's label when there is one), the full
 * recorded order, and, once a shrink has run, the minimal order.
 * The order rides in the flag's own word (`--order="..."`): `bun run` drops an
 * empty argument, so `--order ""` reaches sim.ts as a bare flag and an empty
 * order (a failure before any delivery, or a shrink to nothing) would not replay.
 */
export function replayCommands(scenario: string, seed: number, order: readonly Channel[], traceLabel: string | null, minimal?: readonly Channel[]): string[] {
  const base = `bun run sim ${shellWord(scenario)} --seed ${shellWord(String(seed))}`;
  const orderLine = (o: readonly Channel[]) => `${base} ${orderWord(formatOrder(o))}`;
  const lines = [`${base} --trace${traceLabel ? ` ${shellWord(traceLabel)}` : ""}`, orderLine(order)];
  return minimal ? [...lines, orderLine(minimal)] : lines;
}

/**
 * The free sim bisect for a failing run (evals-ui.md section 5, "Sim bisect"):
 * run from the checkout root, it names the commit that broke the run, at $0.
 * `artifactDir` is the run's folder, `<sim home>/sessions/<session>/<run>`.
 */
export function bisectCommand(artifactDir: string): string {
  return `./evals bisect start --sim ${shellWord(artifactDir)}`;
}
