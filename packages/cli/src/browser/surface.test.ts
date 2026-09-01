/**
 * The command-surface fence.
 *
 * `cast browser` has two implementations behind one vocabulary: the built-in
 * CDP driver (cli.ts) and the agent-browser engine (cliEngine.ts). Agents learn
 * the vocabulary from a snippet, so a verb or flag that exists on one path and
 * not the other is not a missing feature — it is a command an agent has been
 * told to run that now fails, on a machine chosen by which engine happens to be
 * installed.
 *
 * Nothing else catches this. A dropped verb typechecks, and every test passes,
 * because both files are internally consistent — the surface only exists in the
 * relationship between them. A drift audit found three verbs and a dozen flags
 * missing this way, plus a 430-line path nothing called any more.
 *
 * So the surface is diffed rather than the implementation: enumerate what each
 * side registers, and fail on anything the built-in driver offers that the
 * engine does not. Deliberate omissions go in KNOWN_GAPS with a reason and are
 * removed as they land — a gate that is red on arrival gets ignored, and one
 * with unexplained entries becomes a list nobody reads.
 *
 * The parsing is deliberately shallow (a regex over the registration chains).
 * If the registration style changes it will need rewriting, and that is fine:
 * the durable part is diffing the surface, not how the surface is read.
 *
 * Known blind spot: a verb the engine forwards through the passthrough table
 * accepts any flag as far as this gate can tell, so it is exempt from the flag
 * comparison. That is right for a true passthrough and wrong for a flag the
 * ENGINE itself does not implement — the command reaches agent-browser and
 * fails there instead. Verified by construction: an invented flag on `shot`
 * (explicitly registered on both sides) fails the gate, while the same flag on
 * `find` (a passthrough) does not. Catching the second kind means asking the
 * engine what it accepts, which is a live-binary check, not a text diff.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verbs and flags the engine path deliberately does not carry, each with the
 * reason it is acceptable. Empty this as items land; do not add to it without
 * one.
 */
const KNOWN_GAPS: Record<string, { flags?: string[]; verb?: boolean; why: string }> = {
  "click-at": { verb: true, why: "engine restoration pending in jx76a64's rebase" },
  do: { flags: ["--clone", "--real", "--tab"], why: "an engine session drives one tab of its own; real/clone are bridge modes" },
  close: { verb: true, why: "engine restoration pending in jx76a64's rebase" },
  shot: {
    flags: ["--clone", "--jpeg", "--out", "--real", "--ref", "--tab", "--viewports"],
    why: "engine's shot predates the fleet's flags; restoration pending in jx76a64's rebase",
  },
  start: {
    flags: ["--channel"],
    why: "the engine attaches to the managed browser; --channel picks which Chrome the built-in launcher starts",
  },
  stop: {
    flags: ["--force"],
    why: "engine stop closes this session's tab; --force is the built-in driver's refcount override",
  },
  viewport: {
    flags: ["--clone", "--real", "--tab"],
    why: "engine restoration pending in jx76a64's rebase",
  },
};

export interface Surface {
  [verb: string]: Set<string>;
}

/**
 * Verbs and their flags, from `br.command(...)` chains and the passthrough
 * table. A verb registered through the table takes ANY flag — it forwards its
 * whole command line — so it is recorded with an empty flag set, and empty
 * means "accepts anything" rather than "accepts nothing".
 */
export function readSurface(src: string): Surface {
  const out: Surface = {};
  for (const m of src.matchAll(/br\.command\("([a-z0-9-]+)[^"]*"\)((?:.|\n)*?)\.action/g)) {
    out[m[1]] = new Set([...m[2].matchAll(/\.option\("(--[a-z-]+)/g)].map((o) => o[1]));
  }
  for (const m of src.matchAll(/\{ verb: "([a-z0-9-]+)"/g)) {
    if (!(m[1] in out)) out[m[1]] = new Set();
  }
  return out;
}

export interface Drift {
  verbsLost: string[];
  flagsLost: Record<string, string[]>;
}

/** What the engine path does not answer for. Passthrough verbs take any flag. */
export function surfaceDrift(builtin: Surface, engine: Surface): Drift {
  const verbsLost = Object.keys(builtin).filter((v) => !(v in engine)).sort();
  const flagsLost: Record<string, string[]> = {};
  for (const verb of Object.keys(builtin).sort()) {
    const eng = engine[verb];
    if (!eng || eng.size === 0) continue; // absent, or a passthrough that takes anything
    const lost = [...builtin[verb]].filter((f) => !eng.has(f)).sort();
    if (lost.length) flagsLost[verb] = lost;
  }
  return { verbsLost, flagsLost };
}

/** Drop everything KNOWN_GAPS excuses, so only NEW drift fails the gate. */
export function unexplainedDrift(drift: Drift): Drift {
  const verbsLost = drift.verbsLost.filter((v) => !KNOWN_GAPS[v]?.verb);
  const flagsLost: Record<string, string[]> = {};
  for (const [verb, lost] of Object.entries(drift.flagsLost)) {
    const excused = new Set(KNOWN_GAPS[verb]?.flags ?? []);
    const rest = lost.filter((f) => !excused.has(f));
    if (rest.length) flagsLost[verb] = rest;
  }
  return { verbsLost, flagsLost };
}

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (f: string) => fs.readFileSync(path.join(here, f), "utf-8");

/**
 * The engine surface is cliEngine.ts PLUS everything cli.ts registers before
 * the `if (useEngine())` split — those commands (`hosts`, the bridge set) are
 * shared by both paths, and a text reading of cliEngine.ts alone cannot know
 * that.
 */
function surfaces(): { builtin: Surface; engine: Surface } {
  const cliSrc = read("cli.ts");
  const shared = cliSrc.split("if (useEngine())")[0];
  return {
    builtin: readSurface(cliSrc),
    engine: { ...readSurface(shared), ...readSurface(read("cliEngine.ts")) },
  };
}

describe("command surface: built-in driver vs engine", () => {
  test("no verb or flag is offered by one path and missing from the other", () => {
    const { builtin, engine } = surfaces();
    const drift = unexplainedDrift(surfaceDrift(builtin, engine));
    // Printed rather than merely asserted: the failure message has to say WHICH
    // command an agent would be told to run and find missing.
    const report = [
      ...drift.verbsLost.map((v) => `  verb lost:  cast browser ${v}`),
      ...Object.entries(drift.flagsLost).map(([v, f]) => `  flags lost: cast browser ${v} ${f.join(" ")}`),
    ].join("\n");
    expect(report, `\n${report}\n\nAdd to KNOWN_GAPS with a reason, or map it in cliEngine.ts.`).toBe("");
  });

  test("every KNOWN_GAPS entry is still real, so the list cannot rot", () => {
    // An excuse for drift that no longer exists is stale: the item landed and
    // nobody removed it, and the next reader trusts a list that is lying.
    const { builtin, engine } = surfaces();
    const drift = surfaceDrift(builtin, engine);
    const stale: string[] = [];
    for (const [verb, gap] of Object.entries(KNOWN_GAPS)) {
      if (gap.verb && !drift.verbsLost.includes(verb)) stale.push(`${verb} (verb is present now)`);
      for (const f of gap.flags ?? []) {
        if (!drift.flagsLost[verb]?.includes(f)) stale.push(`${verb} ${f} (flag is present now)`);
      }
    }
    expect(stale, `stale KNOWN_GAPS entries — delete them:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});

describe("readSurface", () => {
  test("reads flags off a command chain and treats table verbs as taking anything", () => {
    const s = readSurface(`
      br.command("snapshot").option("--interactive", "x").option("--tab <id>", "y").action(() => {});
      const T = [{ verb: "profiler", desc: "z" }];
    `);
    expect([...s.snapshot]).toEqual(["--interactive", "--tab"]);
    expect(s.profiler.size).toBe(0);
  });

  test("a passthrough verb never reports lost flags", () => {
    const builtin = readSurface(`br.command("eval").option("--tab <id>", "x").action(() => {});`);
    const engine = readSurface(`const T = [{ verb: "eval", desc: "y" }];`);
    expect(surfaceDrift(builtin, engine)).toEqual({ verbsLost: [], flagsLost: {} });
  });

  test("a flag present in one path and absent in the other is drift", () => {
    const builtin = readSurface(`br.command("shot").option("--full", "x").option("--jpeg", "y").action(() => {});`);
    const engine = readSurface(`br.command("shot").option("--full", "x").action(() => {});`);
    expect(surfaceDrift(builtin, engine).flagsLost).toEqual({ shot: ["--jpeg"] });
  });

  test("a verb missing from the engine entirely is drift", () => {
    const builtin = readSurface(`br.command("click-at").option("--tab <id>", "x").action(() => {});`);
    expect(surfaceDrift(builtin, readSurface("")).verbsLost).toEqual(["click-at"]);
  });
});
