import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { changedExternalFields, patchTask } from "./lib/taskWrite";

// A source-level guard over every write of a task row's fields. What it
// protects, and how it reads a write, is written out above `ALLOWED` below.

const SYNCED = /\b(status|assignee|title|labels|priority|description)\s*:/;

/** Every convex source the guards read: the whole directory, walked, rather
 *  than a list of names somebody has to remember to extend. A rule that holds
 *  only in the files it was pointed at is not an invariant, and issueSync.ts
 *  patched synced task fields raw for a year without the suite noticing.
 *  Generated code, type declarations and the tests themselves write nothing. */
function convexSources(dir: string = import.meta.dir, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const at = join(dir, entry);
    const name = rel ? `${rel}/${entry}` : entry;
    if (statSync(at).isDirectory()) out.push(...convexSources(at, name));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(name);
  }
  return out.sort();
}

const SOURCES = convexSources();

/** One file's source with its line comments stripped, so prose naming a field
 *  is never read as a write of it. */
const sourceOf = (file: string) => readFileSync(join(import.meta.dir, file), "utf8").replace(/\/\/[^\n]*/g, "");

/** A file that writes task rows at all. The synced names (status, title,
 *  priority, description) sit on half the tables in the schema, so they are
 *  read only where a task row can be the thing being patched. */
const TOUCHES_TASKS = /Doc<"tasks">|query\("tasks"\)|id\("tasks"\)|insert\("tasks"/;

/** A patch target that names a task row. */
const TASK_TARGET = /\b(?:task|tasks|subtask|cause)\b|task_?[iI]d/;

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

/** A call's top-level arguments, from the text of its bracketed span. */
function callArgs(span: string): string[] {
  const inner = span.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

/** The last argument, which for a patch is its bag: an object literal, or the
 *  identifier of one built elsewhere. */
const patchBag = (span: string) => callArgs(span).at(-1) ?? "";

/** The argument holding the row: `ctx.db.patch(row, bag)` names it first,
 *  `patchTask(ctx, row, bag)` second. */
const patchTarget = (span: string, raw: boolean) => callArgs(span)[raw ? 0 : 1] ?? "";

/**
 * Whether a patch bag spreads keys this test cannot read: `{ ...extra }`,
 * `{ ...diff }`, `{ ...(o.extra ?? {}) }`. The fields such a write really
 * moves are unknown, so a bag like that is read fail-closed.
 *
 * A spread of an object literal is NOT that: `...(cond ? { a: x } : {})` names
 * its key right there, where the field regexes read it like any other.
 */
function hidesKeys(bag: string): boolean {
  let depth = 0;
  for (let i = 0; i < bag.length; i++) {
    const ch = bag[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (depth === 1 && bag.startsWith("...", i)) {
      // The whole top-level element the spread opens, to its comma or the end.
      let d = 0;
      let end = bag.length - 1;
      for (let j = i; j < bag.length; j++) {
        const c = bag[j];
        if ("([{".includes(c)) d++;
        else if (")]}".includes(c)) { if (d === 0) { end = j; break; } d--; }
        else if (c === "," && d === 0) { end = j; break; }
      }
      if (!/\{[^}]*:/.test(bag.slice(i, end))) return true;
      i = end;
    }
  }
  return false;
}

/** The literal a bag handed to a patch at `before` was declared from: the
 *  NEAREST `const|let|var <name> = { … }` above the call, which is how a
 *  reader resolves the name too — one file holds a dozen functions whose bag
 *  is called `updates`. Empty when it was declared empty and filled by
 *  assignment, which the `<name>.<field> =` sweep covers instead. */
function bagLiterals(src: string, name: string, before = src.length): string[] {
  const decls = [...src.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*`, "g"))].filter((m) => m.index! < before);
  const last = decls.at(-1);
  if (!last) return [];
  const at = last.index! + last[0].length;
  return src[at] === "{" ? [balanced(src, at)] : [];
}

// The risk the type system cannot hold (docs/architecture/task-graph.md TG2,
// TG11, docs/architecture/issue-sync.md S5): a task row's fields each have one
// writer, and nothing stops the next raw patch from going around it.
//
//  - the SYNCED fields (status, assignee, title, labels, priority,
//    description) push to a backing Linear or GitHub issue, which only
//    lib/taskWrite.patchTask does. The cascade close, the parent roll-up, the
//    batch status and assign mutations, the workflow runner and the membership
//    sweep each once patched status or assignee raw, and a task closed by
//    `--cascade` stayed open on Linear.
//  - `waits`/`waiting_since` have one writer, `writeWaits`. A write that sets
//    `waits` itself skips the `waiting_since` recompute, the PR's or decision's
//    `waiting_task_ids` back reference — so the wait becomes a trap that can
//    never settle — and the history row.
//  - the edges and links (`blocked_by`, `blocks`, `related`, `found_during`,
//    `superseded_by`) have `writeEdges` and `writeLink`; a write that sets one
//    itself skips its history.
//
// So this reads the source of EVERY convex file, and the allowlist below is the
// record of each deliberate exception. Three shapes of write are read, because
// a literal key is not the only one: `{ waits: next }`, a COMPUTED key
// (`{ [field]: next }`, which is how writeEdges and writeLink themselves write
// and so what a copy of them would look like), and a bag built away from the
// call (`const p = { waits: next }; patchTask(ctx, task, p)`, or `p.waits =
// next`). Every bag a patch is handed by name is swept by that name.
//
// A bag whose keys cannot be read at all — an identifier declared with no
// literal, or a literal carrying a top-level spread — is an offender on a task
// row even when no field name is visible, because the fields it moves are
// unknown. That is how `...extra` rides into a patch.
//
// A graph field name is distinctive, so it is read on every patch in the tree.
// A synced field name is not (half the schema has a `status`), so it is read
// only on a patch whose target names a task row, in a file that touches the
// tasks table, and not at all through patchTask, which is that rule's own
// chokepoint.
//
// It does not read `ctx.db.insert`: a create stores the fields it was given
// with its own history row, which is not a second writer of an existing row.

const GRAPH_FIELDS = "waits|waiting_since|blocked_by|blocks|related|found_during|superseded_by";
const GRAPH = new RegExp(`\\b(${GRAPH_FIELDS})\\s*:`);
/** `{ [field]: next }`: a key the regexes above cannot name. */
const COMPUTED_KEY = /\[\s*[\w.]+\s*\]\s*:/;
/** `<bag>.<field> = …`, for each bag a patch in this file is handed by name. */
const graphAssign = (bag: string) => new RegExp(`\\b${bag}\\.(${GRAPH_FIELDS})\\s*=`, "g");

/** The deliberate exceptions, by file. Calls are `function(target)`, writes
 *  into a bag a patch is handed `function.field`. Every writer and every
 *  sanctioned bypass is named here, so a file holding one is never merely
 *  unseen — and a name here is a claim somebody checked it. */
const ALLOWED: Record<string, string[]> = {
  "lib/taskGraph.ts": [
    "writeEdges(task._id)", // the one writer of blocked_by/blocks: this IS the call
    "writeLink(task._id)",  // the one writer of related/found_during/superseded_by
  ],
  "taskWaits.ts": [
    "writeWaits(task)",     // the one writer of waits/waiting_since: this IS the call
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
    // The funnel every status writer shares. Its bag carries `...extra` for
    // the stamps a caller lands with the status; no caller may put a graph
    // field in it (supersede once did, and now goes through writeLink).
    "moveTaskStatus(task)",
  ],
  "issueSync.ts": [
    // Inbound sync, the one write that must NOT push back (S5): it is the
    // issue's own change arriving, and it records its own history rows above
    // the patch. Its bag spreads the diff, so its keys are not readable here.
    "updateTaskFromIssue(task._id)",
  ],
  "orgInit.ts": [
    // An org proposal's apply: it writes the status stamps itself and calls
    // recordTaskChange and afterStatusEdges around this patch, the way
    // moveTaskStatus does. No backing issue can exist on a row it creates.
    "setTaskStatus(task._id)",
  ],
  "lineGround.ts": [
    // The line's grounding (GroundFields): goal_ref, category, risk,
    // readiness, readiness_note. Typed, so its keys are not at the call site.
    "recordGroundCore(task)",
  ],
  // Same-named fields on OTHER tables. Each is here because the field name is
  // shared with a task's, not because a task write was sanctioned.
  "accountSwitch.ts": ["switchAheadCheck(primary._id)"],                 // devices.cc_auto_switch_state
  "admin_mergeUser.ts": ["mergeDuplicateUser(row._id)"],                 // a computed column of user ids
  "cleanup.ts": ["cascadeHideToNestedChildren(child._id)"],              // conversations
  "conversationLinks.ts": ["addConversationToWorkItem(item._id)"],       // a work item's conversation_ids
  "lib/orgChangeLog.ts": ["writeRow(batch)"],                            // the change log's own head row
  "migrations.ts": ["canonicalizeRepositoryNames(row._id)"],             // a repository column, by name
  "orgProposals.ts": [
    "performCreateProposal(older._id)",                                  // org_proposals.superseded_by
    "backfillSupersession(older._id)",                                   // the same field, backfilled
  ],
  "storyMode.ts": ["writeLevel(existing._id)"],                          // a story level row
  "users.ts": [
    "updateAgentDefaultParams(userId)",                                  // users.agent_default_params
    "deleteAgentDefaultParam(userId)",                                   // the same map
  ],
};

/** Every write of a task field `src` holds that goes around its one writer, as
 *  `function(target)` for a patch and `function.field` for an assignment into a
 *  bag it hands over. */
function offenders(src: string, allowed: string[] = []): string[] {
  const found: string[] = [];
  const touchesTasks = TOUCHES_TASKS.test(src);
  /** The bags a patch here is handed by name, swept below. */
  const bags = new Set<string>();
  for (const m of src.matchAll(/(?:ctx\.db\.patch|patchTask)\(/g)) {
    const raw = m[0].startsWith("ctx");
    const span = balanced(src, m.index! + m[0].length - 1);
    const bag = patchBag(span);
    const named = /^[A-Za-z_$][\w$]*$/.test(bag);
    const onTask = touchesTasks && TASK_TARGET.test(patchTarget(span, raw));
    if (named) bags.add(bag);
    // What this call really writes: its own literal, or every literal the bag
    // it names is declared from.
    const written = named ? bagLiterals(src, bag, m.index!) : [span];
    // A bag whose keys cannot be read: a spread hides them wherever the bag
    // came from, and a bag declared with no literal at all hides them from a
    // RAW patch — through patchTask the `<bag>.<field> =` sweep below reads it.
    const unreadable = onTask
      && (named ? written.some(hidesKeys) || (raw && !written.length) : hidesKeys(bag));
    const graph = written.some((w) => GRAPH.test(w) || COMPUTED_KEY.test(w));
    const synced = onTask && raw && written.some((w) => SYNCED.test(w));
    if (!graph && !synced && !unreadable) continue;
    const key = `${enclosingName(src, m.index!)}(${patchTarget(span, raw)})`;
    if (allowed.includes(key)) continue;
    found.push(`${key}: ${span.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  // The one bag a caller may ride into a status patch, `moveTaskStatus`'s
  // `extra`. It is opaque where it lands (that patch is allowlisted), so it is
  // read where it is written: a graph field in it would reach the row without
  // its writer, which is how supersede once set superseded_by.
  for (const m of src.matchAll(/\bextra:\s*\{/g)) {
    const text = balanced(src, m.index! + m[0].length - 1);
    if (!GRAPH.test(text) && !COMPUTED_KEY.test(text)) continue;
    const key = `${enclosingName(src, m.index!)}.extra`;
    if (allowed.includes(key)) continue;
    found.push(`${key}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  for (const bag of bags) {
    for (const m of src.matchAll(graphAssign(bag))) {
      const key = `${enclosingName(src, m.index!)}.${m[1]}`;
      if (allowed.includes(key)) continue;
      found.push(`${key}: ${m[0]}`);
    }
  }
  return found;
}

describe("a task's fields are written only through their one writer", () => {
  for (const file of SOURCES) {
    test(file, () => {
      expect(
        offenders(sourceOf(file), ALLOWED[file] ?? []),
        `raw task-field writes in ${file}; route synced fields through lib/taskWrite.patchTask, waits through taskWaits.writeWaits and edges/links through lib/taskGraph.writeEdges/writeLink`,
      ).toEqual([]);
    });
  }

  // An allowlist entry is a claim that somebody read that write and found it
  // safe. A claim about a write that is no longer there reads as cover for the
  // next one to land under the same name, so a stale entry fails too.
  test("every allowlist entry still names a write", () => {
    const stale: string[] = [];
    for (const [file, keys] of Object.entries(ALLOWED)) {
      if (!SOURCES.includes(file)) {
        stale.push(`${file} (gone)`);
        continue;
      }
      const raised = offenders(sourceOf(file)).map((o) => o.slice(0, o.indexOf(":")));
      for (const key of keys) if (!raised.includes(key)) stale.push(`${file}: ${key}`);
    }
    expect(stale, "allowlist entries naming no write; drop them").toEqual([]);
  });

  // The guard is only worth its allowlist if it SEES each shape a bypass can
  // take. A literal key was all it read once, which left the computed key the
  // sanctioned writers themselves use invisible.
  test("sees a literal key, a computed key, and a bag built away from the call", () => {
    const literal = `async function sneak(ctx) { await patchTask(ctx, task, { waits: next, updated_at: now }); }`;
    expect(offenders(literal)).toEqual([`sneak(task): (ctx, task, { waits: next, updated_at: now })`]);

    const computed = `async function sneak(ctx) { await ctx.db.patch(task._id, { [field]: next, updated_at: now }); }`;
    expect(offenders(computed)).toEqual([`sneak(task._id): (task._id, { [field]: next, updated_at: now })`]);

    const indirect = `async function sneak(ctx) { const p = { waits: next }; await patchTask(ctx, task, p); }`;
    expect(offenders(indirect)).toEqual([`sneak(task): (ctx, task, p)`]);

    const assigned = `async function sneak(ctx) { const p: any = {}; p.blocked_by = next; await ctx.db.patch(task._id, p); }`;
    expect(offenders(assigned)).toEqual([`sneak.blocked_by: p.blocked_by =`]);

    // A patch naming no task field is no offender, however it is built. A
    // COMPUTED key is read fail-closed, though: the key cannot be told from
    // the source, so such a call is an offender until the allowlist names it
    // and says what it writes.
    const clean = `async function fine(ctx) { const p = { kept: 1 }; await patchTask(ctx, task, p); }`;
    expect(offenders(clean)).toEqual([]);
    const opaque = `async function fine(ctx) { await ctx.db.patch(x._id, { [k]: 1 }); }`;
    expect(offenders(opaque)).toEqual([`fine(x._id): (x._id, { [k]: 1 })`]);
    expect(offenders(opaque, ["fine(x._id)"])).toEqual([]);
  });

  // A synced name is read on a task row only, and a bag whose keys this test
  // cannot read is an offender there even when no name is visible.
  test("reads synced fields on a task row, and fails closed on a bag it cannot read", () => {
    const task = `const t: Doc<"tasks"> = x; async function sneak(ctx) { await ctx.db.patch(task._id, { status: "done" }); }`;
    expect(offenders(task)).toEqual([`sneak(task._id): (task._id, { status: "done" })`]);

    // The same field on another table's row: not a task, so not read.
    const other = `const t: Doc<"tasks"> = x; async function fine(ctx) { await ctx.db.patch(plan._id, { status: "done" }); }`;
    expect(offenders(other)).toEqual([]);
    // And not read at all in a file that never touches a task row.
    const elsewhere = `async function fine(ctx) { await ctx.db.patch(task._id, { status: "done" }); }`;
    expect(offenders(elsewhere)).toEqual([]);

    // patchTask IS the writer of a synced field, so it passes.
    const funnel = `const t: Doc<"tasks"> = x; async function fine(ctx) { await patchTask(ctx, task, { status: "done" }); }`;
    expect(offenders(funnel)).toEqual([]);

    // A top-level spread hides its keys: `...extra` is how a graph field rode
    // into a status patch once, so even patchTask is read fail-closed there.
    const spread = `const t: Doc<"tasks"> = x; async function sneak(ctx) { await patchTask(ctx, task, { ...extra, updated_at: now }); }`;
    expect(offenders(spread)).toEqual([`sneak(task): (ctx, task, { ...extra, updated_at: now })`]);
    // Nested inside a value it hides nothing about the task's own fields.
    const nested = `const t: Doc<"tasks"> = x; async function fine(ctx) { await ctx.db.patch(task._id, { external: { ...task.external, at: now } }); }`;
    expect(offenders(nested)).toEqual([]);

    // A raw patch of a bag this test cannot read at all: an offender until the
    // allowlist says what it writes. Through patchTask the same bag is fine —
    // the `<bag>.<field> =` sweep reads what goes into it.
    const built = `const t: Doc<"tasks"> = x; async function sneak(ctx) { const b: any = f(); await ctx.db.patch(task._id, b); }`;
    expect(offenders(built)).toEqual([`sneak(task._id): (task._id, b)`]);
    const funnelled = `const t: Doc<"tasks"> = x; async function fine(ctx) { const b: any = {}; b.status = "done"; await patchTask(ctx, task, b); }`;
    expect(offenders(funnelled)).toEqual([]);

    // A graph field riding `moveTaskStatus`'s `extra` into the status patch,
    // read where it is written rather than where it lands.
    const rider = `async function sneak(ctx) { await moveTaskStatus(ctx, old, "dropped", { actorUserId: u, extra: { superseded_by: next.short_id } }); }`;
    expect(offenders(rider)).toEqual([`sneak.extra: { superseded_by: next.short_id }`]);
    const fineRider = `async function fine(ctx) { await moveTaskStatus(ctx, old, "done", { extra: { closed_at: now } }); }`;
    expect(offenders(fineRider)).toEqual([]);
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
