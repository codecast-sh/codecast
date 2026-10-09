import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedExternalFields, patchTask } from "./lib/taskWrite";

// A task backed by a Linear or GitHub issue pushes every synced field a write
// moves (docs/architecture/issue-sync.md S5). That only holds if EVERY write of
// those fields goes through lib/taskWrite.patchTask: the cascade close, the
// parent roll-up, the batch status and assign mutations, the workflow runner
// and the membership sweep each once patched status or assignee raw, and a
// task closed by `--cascade` stayed open on Linear. Nothing in the type system
// stops the next raw patch, so this reads the source.
//
// A raw `ctx.db.patch(` whose argument text names a synced field, or passes an
// `updates` bag, must be in the allowlist below with the reason it is safe.

const SYNCED = /\b(status|assignee|title|labels|priority|description)\s*:/;
const FILES = ["tasks.ts", "workflow_runs.ts", "threadMembershipSweep.ts"];

/** Raw patches that never touch a synced field, as `function(target)`. */
const ALLOWED: Record<string, string[]> = {
  "tasks.ts": [
    "updateExecutionStatus(task._id)",   // execution_status only; the bag never holds a synced key
    "incrementRetryCount(task._id)",     // retry_count / execution_status only
    "heartbeat(task._id)",               // last_heartbeat / progress_pct
    "recalcPlanProgress(plan._id)",      // the PLAN row
    "reconcilePlanMembership(planId)",   // the PLAN row
  ],
  "workflow_runs.ts": [
    "gateStackRef(existing._id)",                   // a decision stack's status
    "pauseAtGateCore(args.run_id)",                 // the run's status
    "answerGateCore(run._id)",                      // the run's status
    "cancelCore(run._id)",                          // the run's status
    "create(args.existing_conversation_id)",        // the conversation's title
    "updateProgress(args.run_id)",                  // the run's status
    "updateProgress(run.primary_conversation_id)",  // the conversation's counters
  ],
};

function enclosingName(src: string, at: number): string {
  const head = src.slice(0, at);
  const m = [...head.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=/g)].pop();
  return m ? (m[1] ?? m[2]) : "<top>";
}

/** The text of a bracketed span, from the opener at `open` to its match: one
 *  `ctx.db.patch(` call's arguments, or a patch bag's `{ … }`. */
function balanced(src: string, open: number): string {
  const closer = ({ "(": ")", "{": "}", "[": "]" } as Record<string, string>)[src[open]] ?? ")";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === closer && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** The last top-level argument of a call, which for a patch is its bag: an
 *  object literal, or the identifier of one built elsewhere. */
function patchBag(callArgs: string): string {
  const inner = callArgs.slice(1, -1);
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) start = i + 1;
  }
  return inner.slice(start).trim();
}

/** Every `const|let|var <name> = { … }` in `src`, as the text of each literal:
 *  what a patch handed `<name>` really writes. A bag declared empty and filled
 *  by assignment is covered by the `<name>.<field> =` sweep instead. */
function bagLiterals(src: string, name: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*`, "g"))) {
    const at = m.index! + m[0].length;
    if (src[at] === "{") out.push(balanced(src, at));
  }
  return out;
}

describe("synced task fields are written only through patchTask", () => {
  for (const file of FILES) {
    test(file, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\/[^\n]*/g, "");
      const offenders: string[] = [];
      for (const m of src.matchAll(/ctx\.db\.patch\(/g)) {
        const text = balanced(src, m.index! + "ctx.db.patch".length);
        const bag = /^\([^,]+,\s*updates\s*\)$/.test(text.replace(/\s+/g, " "));
        if (!SYNCED.test(text) && !bag) continue;
        const key = `${enclosingName(src, m.index!)}(${text.slice(1, text.indexOf(",")).trim()})`;
        if ((ALLOWED[file] ?? []).includes(key)) continue;
        offenders.push(`${key}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
      }
      expect(offenders, `raw synced-field patches in ${file}; route them through lib/taskWrite.patchTask`).toEqual([]);
    });
  }
});

// The same risk on the graph fields, which the type system cannot hold either
// (docs/architecture/task-graph.md TG2, TG11): `waits`/`waiting_since` have
// one writer, `writeWaits`, and the edges and links have `writeEdges` and
// `writeLink`. A write that sets `waits` itself skips the `waiting_since`
// recompute, the PR's or decision's `waiting_task_ids` back reference — so the
// wait becomes a trap that can never settle — and the history row; one that
// sets an edge or a link skips its history. This reads the source for a write
// that names a graph field, whether it patches the row directly or hands the
// field to patchTask, and for a field assigned into a patch bag.
//
// A literal key is not the only way to write one, so the sweep reads three
// shapes: `{ waits: next }`, a COMPUTED key (`{ [field]: next }`, which is how
// writeEdges and writeLink themselves write and so what a copy of them would
// look like), and a bag built away from the call (`const p = { waits: next };
// patchTask(ctx, task, p)`, or `p.waits = next`). Every bag a patch is handed
// by name is swept by that name, so none of the three is invisible.
//
// It does not read `ctx.db.insert`: a create stores the edges it was given
// with its own history row, which is not a second writer of an existing row.

const GRAPH_FIELDS = "waits|waiting_since|blocked_by|blocks|related|found_during|superseded_by";
const GRAPH = new RegExp(`\\b(${GRAPH_FIELDS})\\s*:`);
/** `{ [field]: next }`: a key the regex above cannot name. */
const COMPUTED_KEY = /\[\s*[\w.]+\s*\]\s*:/;
/** `<bag>.<field> = …`, for each bag a patch in this file is handed by name. */
const graphAssign = (bag: string) => new RegExp(`\\b${bag}\\.(${GRAPH_FIELDS})\\s*=`, "g");
const GRAPH_FILES = ["taskWaits.ts", "taskLinks.ts", "lib/taskGraph.ts", "tasks.ts", "plans.ts"];

/** The deliberate exceptions: the writers themselves, and the overwrite bag
 *  TG11 sanctions. Calls are `function(target)`, bag writes `function.field`.
 *  Every writer is named here, so a file holding one is never merely unseen. */
const GRAPH_ALLOWED: Record<string, string[]> = {
  "taskWaits.ts": [
    "writeWaits(ctx)",      // the one writer of waits/waiting_since: this IS the call
  ],
  "lib/taskGraph.ts": [
    "writeEdges(task._id)", // the one writer of blocked_by/blocks: this IS the call
    "writeLink(task._id)",  // the one writer of related/found_during/superseded_by
  ],
  "tasks.ts": [
    // `tasks.update` overwrites these in the single bag it patches and builds
    // their history itself (its `trackFields`), which the spec sanctions.
    "update.blocked_by",
    "update.blocks",
    "update.found_during",
    // The web's update path, the same exception: it sets found_during in its
    // one bag and records that line in its own `trackFields`.
    "updateTaskAs.found_during",
  ],
};

/** Every write of a graph field `src` holds, as `function(target)` for a
 *  patch and `function.field` for an assignment into a bag it hands over. */
function graphOffenders(src: string, allowed: string[] = []): string[] {
  const offenders: string[] = [];
  /** The bags a patch here is handed by name, swept below. */
  const bags = new Set<string>();
  for (const m of src.matchAll(/(?:ctx\.db\.patch|patchTask)\(/g)) {
    const text = balanced(src, m.index! + m[0].length - 1);
    const bag = patchBag(text);
    const named = /^[A-Za-z_$][\w$]*$/.test(bag);
    if (named) bags.add(bag);
    // What this call really writes: its own literal, or every literal the bag
    // it names is declared from.
    const written = named ? bagLiterals(src, bag) : [text];
    if (!written.some((w) => GRAPH.test(w) || COMPUTED_KEY.test(w))) continue;
    const key = `${enclosingName(src, m.index!)}(${text.slice(1, text.indexOf(",")).trim()})`;
    if (allowed.includes(key)) continue;
    offenders.push(`${key}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  for (const bag of bags) {
    for (const m of src.matchAll(graphAssign(bag))) {
      const key = `${enclosingName(src, m.index!)}.${m[1]}`;
      if (allowed.includes(key)) continue;
      offenders.push(`${key}: ${m[0]}`);
    }
  }
  return offenders;
}

describe("graph fields are written only through writeWaits/writeEdges/writeLink", () => {
  for (const file of GRAPH_FILES) {
    test(file, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\/[^\n]*/g, "");
      expect(
        graphOffenders(src, GRAPH_ALLOWED[file] ?? []),
        `raw graph-field writes in ${file}; route waits through taskWaits.writeWaits and edges/links through lib/taskGraph.writeEdges/writeLink`,
      ).toEqual([]);
    });
  }

  // The guard is only worth its allowlist if it SEES each shape a bypass can
  // take. A literal key was all it read once, which left the computed key the
  // sanctioned writers themselves use invisible.
  test("sees a literal key, a computed key, and a bag built away from the call", () => {
    const literal = `async function sneak(ctx) { await patchTask(ctx, task, { waits: next, updated_at: now }); }`;
    expect(graphOffenders(literal)).toEqual([`sneak(ctx): (ctx, task, { waits: next, updated_at: now })`]);

    const computed = `async function sneak(ctx) { await ctx.db.patch(task._id, { [field]: next, updated_at: now }); }`;
    expect(graphOffenders(computed)).toEqual([`sneak(task._id): (task._id, { [field]: next, updated_at: now })`]);

    const indirect = `async function sneak(ctx) { const p = { waits: next }; await patchTask(ctx, task, p); }`;
    expect(graphOffenders(indirect)).toEqual([`sneak(ctx): (ctx, task, p)`]);

    const assigned = `async function sneak(ctx) { const p: any = {}; p.blocked_by = next; await ctx.db.patch(task._id, p); }`;
    expect(graphOffenders(assigned)).toEqual([`sneak.blocked_by: p.blocked_by =`]);

    // A patch naming no graph field is no offender, however it is built. A
    // COMPUTED key is read fail-closed, though: the key cannot be told from
    // the source, so such a call is an offender until the allowlist names it
    // and says what it writes.
    const clean = `async function fine(ctx) { const p = { status: "done" }; await patchTask(ctx, task, p); }`;
    expect(graphOffenders(clean)).toEqual([]);
    const opaque = `async function fine(ctx) { await ctx.db.patch(x._id, { [k]: 1 }); }`;
    expect(graphOffenders(opaque)).toEqual([`fine(x._id): (x._id, { [k]: 1 })`]);
    expect(graphOffenders(opaque, ["fine(x._id)"])).toEqual([]);
  });
});

describe("changedExternalFields", () => {
  const task = { title: "a", status: "open", labels: ["x", "y"], priority: "high" };
  test("names only the synced fields the patch really moves", () => {
    expect(changedExternalFields(task, { title: "a", status: "done", updated_at: 1 })).toEqual(["status"]);
    expect(changedExternalFields(task, { labels: ["y", "x", "x"] })).toEqual([]);
    expect(changedExternalFields(task, { labels: ["y"] })).toEqual(["labels"]);
    expect(changedExternalFields(task, { assignee: undefined })).toEqual([]);
    expect(changedExternalFields({ ...task, assignee: "u1" }, { assignee: undefined })).toEqual(["assignee"]);
  });
});

describe("patchTask", () => {
  const harness = (task: any) => {
    const patched: any[] = [];
    const scheduled: any[] = [];
    const ctx = {
      db: { patch: async (id: any, p: any) => { patched.push([id, p]); } },
      scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } },
    };
    return { ctx, patched, scheduled, task };
  };

  test("patches, then pushes exactly the moved synced fields of a backed task", async () => {
    const h = harness({ _id: "t1", title: "a", status: "open", external: { provider: "linear", id: "x" } });
    await patchTask(h.ctx, h.task, { status: "done", closed_at: 5, title: "a" });
    expect(h.patched).toEqual([["t1", { status: "done", closed_at: 5, title: "a" }]]);
    expect(h.scheduled).toEqual([{ task_id: "t1", fields: ["status"] }]);
  });

  test("a task with no provider twin patches and pushes nothing", async () => {
    const h = harness({ _id: "t2", title: "a", status: "open" });
    await patchTask(h.ctx, h.task, { status: "done" });
    expect(h.patched.length).toBe(1);
    expect(h.scheduled).toEqual([]);
  });
});
