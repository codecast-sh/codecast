// The flow a variant extends, as `cast flow show` finds and prints it: the file its `extends` names, else the
// library flow of that name, never the variant itself.
import * as fs from "node:fs";
import * as path from "node:path";
import { variantChangeLines, type VariantChanges } from "./flowLibrary.js";
import type { WorkflowGraph } from "./workflow/types.js";
import { graphExtends, parseWorkflowSource } from "./workflow/parser.js";
import { describeFlow, type PoolFlow } from "./workflow/flowPool.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates.js";
import type { FoundFlow } from "./flowCommand.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** What a variant changes from the flow it extends, under its header. */
export function printVariantChanges(slug: string, base: PoolFlow | null, changes: VariantChanges | null): void {
  if (!base) { console.log(dim(`extends ${slug}, which this library does not hold`)); return; }
  const lines = changes ? variantChangeLines(changes) : [];
  console.log(`extends ${bold(base.label)} ${dim(`(${slug})`)}${lines.length ? ", changing:" : changes ? ", changing nothing" : ""}`);
  for (const l of lines) console.log(`  ${l}`);
}

/**
 * The flow a variant extends: the file its `extends` names, else the library flow of that name, never the variant
 * itself (a repo's change.cast that extends "change" shadows the shipped change in the pool, and extends that).
 */
export function baseOf(found: FoundFlow, pool: ReadonlyArray<PoolFlow>): PoolFlow | null {
  if (!found.extends) return null;
  const shipped = Object.prototype.hasOwnProperty.call(BUILTIN_WORKFLOW_TEMPLATES, found.extends) ? describeFlow(found.extends, BUILTIN_WORKFLOW_TEMPLATES[found.extends], "shipped", null) : null;
  return baseBeside(found) ?? pool.find((p) => p.slug === found.extends && (!p.file || p.file !== found.file)) ?? shipped;
}

/** A graph file's base read from where its `extends` points, for a variant whose base is not in the library. */
function baseBeside(f: FoundFlow): PoolFlow | null {
  let ext: string | undefined;
  try { ext = f.file ? graphExtends(f.source) : undefined; } catch { return null; }
  const file = ext ? path.resolve(path.dirname(f.file!), ext) : null;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return describeFlow(path.basename(file).replace(/\.cast$/, ""), fs.readFileSync(file, "utf-8"), "repo", file);
}

/** A pool flow's parsed graph, or null when it has none or does not parse. */
export function graphOf(f: (PoolFlow & { source?: string }) | null | undefined): WorkflowGraph | null {
  if (!f || f.errors.length) return null;
  const source = f.source ?? (f.file ? fs.readFileSync(f.file, "utf-8") : BUILTIN_WORKFLOW_TEMPLATES[f.slug]);
  if (!source) return null;
  try { return parseWorkflowSource(source, f.file ? path.dirname(f.file) : undefined); } catch { return null; }
}
