// The sim's failure report (docs/architecture/multiplayer-sim-harness.md,
// section 3.9): one block a person can read cold, the replay lines that
// reproduce it, and the artifacts written beside it.
//
// Pure apart from the artifact writer: it takes the delivery ring, the row
// pair to diff and the labels, and never imports the store. The field diff is
// the one place PAYLOAD_DENYLIST is applied, so a denylisted field (a doc's
// content, a task's steps) never reaches a report.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAYLOAD_DENYLIST } from "@codecast/convex/convex/syncLog";
import { canonical } from "@codecast/shared/contracts/orgChange";
import { formatOrder, type Channel, type Delivery } from "./net";
import type { SimLabels } from "./labels";

export type SimMode = "scripted" | "interleave" | "order";

// A delivery as the report and events.jsonl see it: everything but the thunk.
export type DeliveryRecord = Omit<Delivery, "run">;

type Row = Record<string, unknown>;

export interface FailureContext {
  scenario: string;
  mode: SimMode;
  seed: number;
  /** The verb or point check that was running, e.g. `settle #2`. */
  step: string;
  /** Deliveries made so far in the run (a count; the ring labels each delivery by its enqueue #seq). */
  delivery: number;
  /** The invariant, or the point check, that failed. */
  invariant: { id: string; meaning: string };
  /** The check's own account of what it saw. */
  message?: string;
  window?: { name: string; principal: string; scope: string };
  /** The row the check names, as the server and the replica hold it (null when absent). */
  row?: { table: string; id: string; server: Row | null; replica: Row | null };
  ring: readonly DeliveryRecord[];
  order: readonly Channel[];
  labels: SimLabels;
  /** Virtual clock origin; delivery times print as offsets from it. */
  t0?: number;
  /** Replay commands for a run `bun run sim` does not drive (the legacy suites). Default: the sim's two lines. */
  replay?: string[];
  /** The task of the red or known marker naming this failure: the run was expected to stop here. */
  expected?: string;
}

export interface FieldDelta {
  field: string;
  server: unknown;
  replica: unknown;
}

const RING_SHOWN = 12;
const VALUE_MAX = 120;
const ABSENT = Symbol("absent");

// The fields where server and replica disagree, minus the table's
// PAYLOAD_DENYLIST. A field one side lacks is reported as absent there.
export function fieldDiff(table: string, server: Row | null, replica: Row | null): FieldDelta[] {
  const deny = PAYLOAD_DENYLIST[table];
  const fields = new Set([...Object.keys(server ?? {}), ...Object.keys(replica ?? {})]);
  const out: FieldDelta[] = [];
  for (const field of [...fields].sort()) {
    if (deny?.has(field)) continue;
    const s = server && field in server ? server[field] : ABSENT;
    const r = replica && field in replica ? replica[field] : ABSENT;
    if (s !== ABSENT && r !== ABSENT && canonical(s) === canonical(r)) continue;
    out.push({ field, server: s, replica: r });
  }
  return out;
}

const SHELL_SAFE = /^[\w:/.@%+=,-][\w:/.@%+=,#-]*$/;
const shellWord = (s: string) => (SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function replayLines(ctx: Pick<FailureContext, "scenario" | "seed" | "order" | "row" | "labels">): [trace: string, order: string] {
  const base = `bun run sim ${shellWord(ctx.scenario)} --seed ${ctx.seed}`;
  const trace = ctx.row ? ` --trace ${shellWord(ctx.labels.label(ctx.row.id))}` : " --trace";
  return [base + trace, `${base} --order "${formatOrder(ctx.order)}"`];
}

// Where a run's artifacts go: $SIM_OUT, else a fixed folder under the temp dir
// (failures always write; passes only when SIM_OUT is set, which the DSL decides).
export function artifactDir(scenario: string, mode: SimMode, seed: number, root = process.env.SIM_OUT || join(tmpdir(), "codecast-sim")): string {
  return join(root, `${scenario}-${mode}-${seed}`);
}

function renderValue(v: unknown, labels: SimLabels): string {
  if (v === ABSENT) return "(absent)";
  const text = labels.relabel(canonical(v));
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX - 3)}...` : text;
}

// One aligned row per delivery, in delivery order: its enqueue #seq, virtual
// time, channel, label, producer. Deliveries run out of enqueue order, so the
// #seq column is not sorted.
// The DSL's SIM_TRACE stream prints one row at a time through it.
export function renderDeliveries(ds: readonly DeliveryRecord[], labels: SimLabels, t0: number | undefined): string[] {
  const rows = ds.map((d) => [
    `#${d.seq}`,
    t0 === undefined ? `@${d.due}` : `+${d.due - t0}ms`,
    labels.relabel(d.channel),
    labels.relabel(d.label),
    `by ${labels.relabel(d.producer)}`,
  ]);
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join("  "));
}

export function formatFailure(ctx: FailureContext, artifacts: string): string {
  const { labels } = ctx;
  const lines = [
    `sim failure${ctx.expected ? ` (expected, red: ${ctx.expected})` : ""}: ${ctx.scenario} [${ctx.mode} seed ${ctx.seed}] at step "${ctx.step}", after ${ctx.delivery} deliveries`,
    `  ${ctx.invariant.id}: ${ctx.invariant.meaning}`,
  ];
  if (ctx.message) lines.push(...labels.relabel(ctx.message).split("\n").map((l) => `  ${l}`));
  if (ctx.window) {
    const w = ctx.window;
    lines.push(`  window ${w.name} (principal ${labels.relabel(w.principal)}, scope ${labels.relabel(w.scope)})`);
  }
  if (ctx.row) {
    const { table, id, server, replica } = ctx.row;
    lines.push(`  row ${labels.label(id)} (${table})`);
    if (!server) lines.push("    absent on the server");
    if (!replica) lines.push("    absent in the replica");
    if (server && replica) {
      const deltas = fieldDiff(table, server, replica);
      if (deltas.length === 0) lines.push("    no field differs outside the payload denylist");
      const width = Math.max(0, ...deltas.map((d) => d.field.length));
      for (const d of deltas) {
        lines.push(`    ${d.field.padEnd(width)}  server ${renderValue(d.server, labels)}  replica ${renderValue(d.replica, labels)}`);
      }
    }
  }
  const shown = ctx.ring.slice(-RING_SHOWN);
  lines.push(`  last ${shown.length} deliveries, in delivery order (#: enqueue seq):`, ...renderDeliveries(shown, labels, ctx.t0).map((l) => `    ${l}`));
  lines.push("  replay:", ...(ctx.replay ?? replayLines(ctx)).map((l) => `    ${l}`));
  lines.push(`  artifacts: ${artifacts}`);
  return lines.join("\n");
}

export interface RunArtifacts {
  /** Every delivery of the run, in order; one JSON line each. */
  events: readonly DeliveryRecord[];
  world: unknown;
  final: unknown;
}

export const eventsJsonl = (events: readonly DeliveryRecord[]): string =>
  events.map((d) => canonical({ seq: d.seq, channel: d.channel, due: d.due, label: d.label, producer: d.producer })).join("\n") + (events.length ? "\n" : "");

export function writeArtifacts(dir: string, result: unknown, run: RunArtifacts): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(dir, "events.jsonl"), eventsJsonl(run.events));
  writeFileSync(join(dir, "world.json"), JSON.stringify(run.world, null, 1));
  writeFileSync(join(dir, "final.json"), JSON.stringify(run.final, null, 1));
}

export class SimFailure extends Error {
  constructor(message: string, readonly ctx: FailureContext, readonly artifacts: string) {
    super(message);
    this.name = "SimFailure";
  }
}

// Writes the artifacts, prints the block and throws it.
export function reportFailure(ctx: FailureContext, run: RunArtifacts, root?: string): never {
  const dir = artifactDir(ctx.scenario, ctx.mode, ctx.seed, root);
  const text = formatFailure(ctx, dir);
  const { labels, ring, order, ...facts } = ctx;
  const diff = (ctx.row ? fieldDiff(ctx.row.table, ctx.row.server, ctx.row.replica) : [])
    .map((d) => ({ field: d.field, server: renderValue(d.server, labels), replica: renderValue(d.replica, labels) }));
  // The raw rows stay out of result.json: the rendered diff is what was compared.
  const row = ctx.row && { table: ctx.row.table, id: ctx.row.id, label: labels.label(ctx.row.id), diff };
  writeArtifacts(dir, { ...facts, row, order: formatOrder(order), labels: Object.fromEntries(labels.entries()), text }, run);
  console.error(text);
  throw new SimFailure(text, ctx, dir);
}
