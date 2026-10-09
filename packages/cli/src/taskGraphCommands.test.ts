import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNKNOWN_BLOCKER_STATUS, type PrWaitTarget, type TaskWait } from "@codecast/shared/tasks";
import { namedWorkspace, teamFlagFor, workspaceOfScope } from "./resolveWorkspace";
import { recordTaskStart } from "./taskPulse";
import {
  applyBlockers,
  releasedByClose,
  releasedByCloseLine,
  removalVerdict,
  createdHoldingBlockers,
  createdTaskBlocker,
  createPlanSteps,
  depAddedLine,
  holdingBlockers,
  noWaitRemovedLine,
  offFrontierLines,
  parkAfterBlocking,
  planStepBase,
  planStepsNextAction,
  planTemplate,
  planWorkspace,
  routeBlockerRef,
  splitRefs,
  stepsFromTemplate,
  stepsFromText,
  stepsFromTitles,
  supersededLine,
  taskGraphSections,
  unappliedRefsAdvice,
  waitAddedLine,
  waitBody,
  type GraphDeps,
} from "./taskGraphCommands";

const NOW = Date.UTC(2026, 9, 8, 12);

describe("routeBlockerRef", () => {
  test("tasks go to the dependency routes, everything else to the wait routes", () => {
    expect(routeBlockerRef("ct-012")).toEqual({ kind: "task", ref: "ct-12" });
    expect(routeBlockerRef("#42")).toEqual({ kind: "wait", ref: "#42", barePr: true });
    expect(routeBlockerRef("acme/api#42:checks")).toEqual({ kind: "wait", ref: "acme/api#42:checks", barePr: false });
    expect(routeBlockerRef("sd-4")).toEqual({ kind: "wait", ref: "sd-4", barePr: false });
    expect(routeBlockerRef("2h", { now: NOW })).toEqual({ kind: "wait", ref: "2h", barePr: false });
  });

  test("an unknown ref teaches the accepted forms", () => {
    expect(() => routeBlockerRef("tomorrow")).toThrow(/a task \(ct-12\), a PR \(#42/);
    expect(() => routeBlockerRef("42")).toThrow(/write #42 for a pull request or ct-42 for a task/);
  });

  test("removal also takes a wait's id, and says so when nothing matches", () => {
    expect(routeBlockerRef("wmg3k2p1x4", { removing: true })).toEqual({ kind: "wait_id", id: "wmg3k2p1x4" });
    expect(() => routeBlockerRef("whenever", { removing: true })).toThrow(/\. A wait can also be removed by its id/);
    // A met time wait stays as history, so removing it may name a past time.
    expect(routeBlockerRef("2026-01-01T09:00Z", { removing: true }).kind).toBe("wait");
    expect(() => routeBlockerRef("2026-01-01T09:00Z")).toThrow(/already past/);
    expect(() => routeBlockerRef("wmg3k2p1x4")).toThrow();
  });

  test("a wait id with no digit in it is still a wait id (base36 may have none)", () => {
    expect(routeBlockerRef("wmuzabcdxyz", { removing: true })).toEqual({ kind: "wait_id", id: "wmuzabcdxyz" });
    expect(routeBlockerRef("wmuzabcdxy", { removing: true })).toEqual({ kind: "wait_id", id: "wmuzabcdxy" });
  });
});

test("splitRefs trims and drops blanks", () => {
  expect(splitRefs(" ct-1, #42:checks ,,sd-3 ")).toEqual(["ct-1", "#42:checks", "sd-3"]);
  expect(splitRefs(undefined)).toEqual([]);
});

describe("the spelling an agent surface prints a time wait in, pasted back", () => {
  // `cast task context` prints "Oct 9, 2026 07:00 UTC" and its help invites
  // pasting that into --remove-blocked-by. The comma in it used to split the
  // value into two refs, and the run died naming only "Oct 9".
  test("is one ref, not two, and routes as the moment it names", () => {
    expect(splitRefs("Oct 9, 2026 07:00 UTC")).toEqual(["Oct 9, 2026 07:00 UTC"]);
    expect(routeBlockerRef("Oct 9, 2026 07:00 UTC", { removing: true })).toEqual({ kind: "wait", ref: "2026-10-09T07:00Z", barePr: false });
    // Wherever it sits in the list, not only as the whole value: the help
    // invites pasting it back, and an agent that combined refs in one flag was
    // refused with `"Oct 9" is not a blocker`.
    expect(splitRefs("ct-1,Oct 9, 2026 07:00 UTC")).toEqual(["ct-1", "Oct 9, 2026 07:00 UTC"]);
    expect(splitRefs("Oct 9, 2026 07:00 UTC,ct-1")).toEqual(["Oct 9, 2026 07:00 UTC", "ct-1"]);
    expect(splitRefs("ct-1,Oct 9, 2026 07:00 UTC,sd-4")).toEqual(["ct-1", "Oct 9, 2026 07:00 UTC", "sd-4"]);
    // Nothing else is rejoined: a bare "Oct 9" is no ref, and neither half of
    // the spelling stands on its own.
    expect(splitRefs("ct-1,Oct 9")).toEqual(["ct-1", "Oct 9"]);
  });

  test("names the ref form when the zone it was printed in fixes no instant", () => {
    expect(() => routeBlockerRef("Oct 9, 2026 07:00 BST", { removing: true }))
      .toThrow(/"Oct 9, 2026 07:00 BST" names a moment but not its instant: write it as a ref \(2026-10-14T09:00Z\), or remove the wait by the `id w…`/);
  });
});

describe("waitBody", () => {
  test("carries the zone and the session; a wait id goes as wait_id", () => {
    const body = waitBody("ct-5", { kind: "wait_id", id: "wabcdef1" }, { cwd: "/nonexistent", sessionId: "sess" });
    expect(body).toMatchObject({ short_id: "ct-5", wait_id: "wabcdef1", conversation_id: "sess" });
    expect(typeof body.time_zone).toBe("string");
  });

  test("a bare #42 outside a git checkout sends no repository; the server tries the task's project", () => {
    const body = waitBody("ct-5", { kind: "wait", ref: "#42", barePr: true }, { cwd: "/" });
    expect(body.ref).toBe("#42");
    expect(body.repository).toBeUndefined();
    expect(body.conversation_id).toBeUndefined();
  });

  test("inside a git checkout, adding a bare #42 names the checkout's repository and removing it does not", () => {
    const repo = import.meta.dir;
    const r = { kind: "wait" as const, ref: "#42", barePr: true };
    expect(waitBody("ct-5", r, { cwd: repo }).repository).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const removal = waitBody("ct-5", r, { cwd: repo, removing: true });
    expect(removal).toEqual({ short_id: "ct-5", ref: "#42", time_zone: expect.any(String) });
  });
});

type PrWait = Extract<TaskWait, PrWaitTarget>;
const prWait = (state: TaskWait["state"], note?: string, pr_number = 42): PrWait => ({
  id: `w${pr_number}`, kind: "pr_merged" as const, repository: "acme/api", pr_number, state, created_at: NOW, ...(note ? { note } : {}),
});

test("waitAddedLine: waiting, met at once, already there", () => {
  expect(waitAddedLine("ct-5", { wait: prWait("waiting"), met: false })).toBe("ct-5 is waiting on PR #42");
  expect(waitAddedLine("ct-5", { wait: prWait("met", "already merged"), met: true })).toBe("ct-5 has nothing to wait for: PR #42 merged already");
  expect(waitAddedLine("ct-5", { wait: prWait("waiting"), met: false, existing: true })).toBe("ct-5 was already waiting on PR #42");
  const at = Date.now() + 3_600_000;
  expect(waitAddedLine("ct-5", { wait: { id: "w2", kind: "time", at, state: "waiting", created_at: NOW }, met: false })).toMatch(/^ct-5 is waiting until (\w{3} )?\d\d:\d\d$/);
});

test("depAddedLine: a finished blocker blocks nothing", () => {
  const dep = (status: string) => depAddedLine("ct-9", { kind: "task", ref: "ct-5", status });
  expect(dep("in_progress")).toBe("ct-9 is blocked by ct-5");
  expect(dep("done")).toBe("ct-5 is already done, so it does not block ct-9");
  expect(dep("dropped")).toBe("ct-5 is already dropped, so it does not block ct-9");
  // An older server answers no status for an edge it accepted: unknown holds,
  // so the task still reads as blocked (createdTaskBlocker is the one caller
  // that reads silence as "no such task", and only create can answer that).
  expect(dep(UNKNOWN_BLOCKER_STATUS)).toBe("ct-9 is blocked by ct-5");
});

describe("a created task blocker that names no task", () => {
  // tasks.create keeps the write and answers no status for a ref it could not
  // resolve; assertDependencyEdges already refused every ref outside the
  // creator's workspace, so the silence is "no such task". Readiness reads the
  // stored ref the same way (missing, holding nothing), so the create's own
  // output must not claim a block cast task ready does not see.
  test("is not blocked by it, and is not warned about a wake that is not coming", () => {
    expect(createdTaskBlocker({ ref: "ct-99999" })).toEqual({ kind: "task", ref: "ct-99999", missing: true });
    expect(depAddedLine("ct-5", createdTaskBlocker({ ref: "ct-99999" })))
      .toBe("ct-99999 names no task, so it does not block ct-5 (cast task dep ct-5 --remove-blocked-by ct-99999 drops the edge)");
    expect(createdHoldingBlockers({ blockers: [{ ref: "ct-99999" }] })).toEqual([]);
    expect(parkAfterBlocking("s1", "ct-5", createdHoldingBlockers({ blockers: [{ ref: "ct-99999" }] }), null)).toBeNull();
    // A blocker that DID resolve still holds, and the create still warns.
    expect(createdHoldingBlockers({ blockers: [{ ref: "ct-7", status: "open" }] }))
      .toEqual([{ kind: "task", ref: "ct-7", status: "open" }]);
  });
});

describe("noWaitRemovedLine", () => {
  test("a removal that matched nothing names the handle given and where the real ones are", () => {
    expect(noWaitRemovedLine("ct-5", { kind: "wait_id", id: "wzzzzzzzzzz" }))
      .toBe("ct-5 has no wait with id wzzzzzzzzzz; cast task show ct-5 lists its waits");
    expect(noWaitRemovedLine("ct-5", { kind: "wait", ref: "#42", barePr: true }))
      .toBe("ct-5 has no wait on #42; cast task show ct-5 lists its waits");
  });
});

describe("parkAfterBlocking", () => {
  const open = [prWait("waiting")];
  test("a session holding the task is told how to park on it", () => {
    // The work is underway: this session started the task and got far enough
    // to find a new blocker, so parking is its call — the same words the
    // compaction block gives the same task in the same state.
    expect(parkAfterBlocking("s1", "ct-5", open, { task: "CT-005", started: true }))
      .toMatch(/^If the work cannot go on until it clears, run cast state --status dormant "Waiting on PR #42"/);
  });

  test("a session that filed or never held the task is told nothing wakes it", () => {
    const line = "This session does not hold ct-5, so nothing wakes it when this clears (cast task start ct-5 to hold it).";
    expect(parkAfterBlocking("s1", "ct-5", open, { task: "ct-5" })).toBe(line);
    expect(parkAfterBlocking("s1", "ct-5", open, { task: "ct-6", started: true })).toBe(line);
    expect(parkAfterBlocking("s1", "ct-5", [...open, { kind: "task", ref: "ct-2", status: "open" }], null)).toMatch(/when these clear/);
  });

  test("who holds the task is the server's answer when it gave one, not the pulse", () => {
    // The pulse is cleared only when THIS session closes the task, so after
    // another session took it over (`cast task start --take`, a board handoff)
    // it still names a task this session no longer holds — and a clearing wakes
    // the new owner alone (TG2), so the park would wait on a wake that never
    // comes.
    expect(parkAfterBlocking("s1", "ct-5", open, { task: "ct-5", started: true }, {}, false))
      .toBe("This session does not hold ct-5, so nothing wakes it when this clears (cast task start ct-5 to hold it).");
    // And the other way: a session the server says holds it is told how to park
    // even where no pulse file was written (a session the server spawned).
    expect(parkAfterBlocking("s1", "ct-5", open, null, {}, true))
      .toMatch(/^If the work cannot go on until it clears, run cast state --status dormant "Waiting on PR #42"/);
  });

  test("nothing to say outside a session or when nothing holds the task", () => {
    expect(parkAfterBlocking(null, "ct-5", open, null)).toBeNull();
    expect(parkAfterBlocking("s1", "ct-5", [], { task: "ct-5", started: true })).toBeNull();
  });
});

describe("unappliedRefsAdvice", () => {
  test("a refused ref names the refs after it, with the command that applies them", () => {
    // The refused ref is named by the error itself; what nothing else says is
    // that the rest were never attempted.
    expect(unappliedRefsAdvice("ct-9", ["2h", "#42", "ct-5"], 1, "add"))
      .toBe("ct-5 was not added; retry it with cast task dep ct-9 --blocked-by ct-5");
    expect(unappliedRefsAdvice("ct-9", ["#42", "ct-5", "sd-4"], 0, "remove"))
      .toBe("ct-5; sd-4 were not removed; retry them with cast task dep ct-9 --remove-blocked-by 'ct-5,sd-4'");
    // A time wait's absolute spelling carries a comma of its own, and splitRefs
    // rejoins it wherever it sits in the list, so one command still applies the
    // whole remainder; flagArg quotes it into one shell word.
    expect(unappliedRefsAdvice("ct-9", ["#42", "Oct 9, 2026 07:00 UTC", "ct-5"], 0, "add"))
      .toBe("Oct 9, 2026 07:00 UTC; ct-5 were not added; retry them with cast task dep ct-9 --blocked-by 'Oct 9, 2026 07:00 UTC,ct-5'");
    // Nothing followed the refusal: the error already says everything.
    expect(unappliedRefsAdvice("ct-9", ["#42", "ct-5"], 1, "add")).toBeNull();
  });
});

describe("applyBlockers", () => {
  /** A shell with its own pulse directory, so the session can hold the task. */
  function heldDeps(answer: (path: string, body: any) => any) {
    const dir = mkdtempSync(join(tmpdir(), "apply-blockers-"));
    process.env.CODECAST_DIR = dir;
    const said: string[] = [];
    const log = console.log;
    console.log = (text = "") => { said.push(String(text)); };
    const deps: GraphDeps = {
      cliPost: async (path, body) => answer(path, body),
      sessionId: () => "s1",
      cwd: () => "/repo",
      printJson: () => {},
      workspace: async () => ({ workspace: "personal" }),
      namedScope: async () => null,
    };
    return { deps, said, restore: () => { console.log = log; } };
  }

  test("the parking line names everything that holds the task, not only what this call added", async () => {
    const prev = process.env.CODECAST_DIR;
    // The task was already blocked by ct-1 before this call added the wait.
    const { deps, said, restore } = heldDeps((path) =>
      path === "/cli/work/wait" ? { wait: prWait("waiting"), met: false }
      : path === "/cli/work/get" ? { short_id: "ct-5", status: "open", waits: [prWait("waiting")], links: { blocked_by: [{ kind: "task", ref: "ct-1", status: "open" }] } }
      : {});
    try {
      await recordTaskStart("s1", "ct-5", undefined, async () => {});
      await applyBlockers(deps, "ct-5", ["#42"], "add");
      // `cast task context` builds the same sentence from the same whole set,
      // so the two surfaces pin one reason rather than two.
      expect(said.join("\n")).toContain('cast state --status dormant "Waiting on ct-1 and 1 more"');
    } finally {
      restore();
      process.env.CODECAST_DIR = prev;
    }
  });

  test("the server decides who holds the task, so a pulse for a task since taken over does not park", async () => {
    const prev = process.env.CODECAST_DIR;
    // The pulse still names ct-5 — nothing clears it when another session
    // takes the task over — but only the holder is woken when a blocker
    // clears (TG2), so parking here would wait on a wake that never comes.
    const asked: any[] = [];
    const { deps, said, restore } = heldDeps((path, body) => {
      if (path === "/cli/work/wait") return { wait: prWait("waiting"), met: false };
      if (path === "/cli/work/get") {
        asked.push(body);
        return { short_id: "ct-5", status: "open", waits: [prWait("waiting")], held: false };
      }
      return {};
    });
    try {
      await recordTaskStart("s1", "ct-5", undefined, async () => {});
      await applyBlockers(deps, "ct-5", ["#42"], "add");
      expect(asked[0]).toMatchObject({ short_id: "ct-5", conversation_id: "s1" });
      expect(said.join("\n")).toContain("This session does not hold ct-5, so nothing wakes it");
      expect(said.join("\n")).not.toContain("--status dormant");
    } finally {
      restore();
      process.env.CODECAST_DIR = prev;
    }
  });

  test("a read-back that fails leaves the blockers this call added: a partial pin beats none", async () => {
    const prev = process.env.CODECAST_DIR;
    const { deps, said, restore } = heldDeps((path) => {
      if (path === "/cli/work/wait") return { wait: prWait("waiting"), met: false };
      if (path === "/cli/work/get") throw new Error("no such route");
      return {};
    });
    try {
      await recordTaskStart("s1", "ct-5", undefined, async () => {});
      await applyBlockers(deps, "ct-5", ["#42"], "add");
      // The PR is named as this checkout reads it (checkoutWords), as every
      // line above the pin is.
      expect(said.join("\n")).toContain('cast state --status dormant "Waiting on PR acme/api#42"');
    } finally {
      restore();
      process.env.CODECAST_DIR = prev;
    }
  });

  // The question a removal is asked for is whether the task can move now. The
  // web's page and the phone print that verdict over the same list (TG12) and
  // the CLI printed nothing, so the agent `failedWaitAdvice` and
  // `stalledWaitAdvice` send here had to spend a `cast task show` on it.
  test("a removal says whether anything still holds the task, and what to do next", async () => {
    const prev = process.env.CODECAST_DIR;
    const asked: any[] = [];
    const { deps, said, restore } = heldDeps((path, body) => {
      if (path === "/cli/work/unwait") return { removed: [prWait("failed", "closed without merging")] };
      if (path === "/cli/work/get") { asked.push(body); return { short_id: "ct-5", status: "open", waits: [], links: {} }; }
      return {};
    });
    try {
      await applyBlockers(deps, "ct-5", ["#42"], "remove");
      expect(asked.length).toBe(1);
      expect(said.join("\n")).toContain("ct-5 is no longer waiting on PR acme/api#42");
      expect(said.join("\n")).toContain("ct-5 is unblocked: cast task start ct-5 takes it");
    } finally {
      restore();
      process.env.CODECAST_DIR = prev;
    }
  });

  test("a removal that leaves another blocker names it, and tells the holding session how to park", async () => {
    const prev = process.env.CODECAST_DIR;
    const { deps, said, restore } = heldDeps((path) =>
      path === "/cli/work/unwait" ? { removed: [prWait("failed", "closed without merging")] }
      : path === "/cli/work/get" ? { short_id: "ct-5", status: "in_progress", waits: [], held: true, links: { blocked_by: [{ kind: "task", ref: "ct-1", status: "open" }] } }
      : {});
    try {
      await recordTaskStart("s1", "ct-5", undefined, async () => {});
      await applyBlockers(deps, "ct-5", ["#42"], "remove");
      expect(said.join("\n")).toContain("ct-5 is still blocked by ct-1");
      expect(said.join("\n")).toContain('cast state --status dormant "Waiting on ct-1"');
    } finally {
      restore();
      process.env.CODECAST_DIR = prev;
    }
  });
});

// The close is the terminal node of the flow, and it is the only reader the
// server can tell: the unblock wake goes to the dependent's owner (TG2), which
// for work nobody has claimed is nobody.
describe("releasedByClose", () => {
  function readDeps(rows: Record<string, any>) {
    const asked: string[] = [];
    const deps: GraphDeps = {
      cliPost: async (path, body) => {
        if (path !== "/cli/work/get") return {};
        asked.push(body.short_id);
        const row = rows[body.short_id];
        if (!row) throw new Error("not found");
        return row;
      },
      sessionId: () => null,
      cwd: () => "/repo",
      printJson: () => {},
      workspace: async () => ({ workspace: "personal" }),
      namedScope: async () => null,
    };
    return { deps, asked };
  }

  test("names the dependents nothing holds any more, skips the ones still blocked, and claims the first", async () => {
    const { deps, asked } = readDeps({
      "ct-5": { short_id: "ct-5", _id: "id_ct-5", status: "done", links: { blocks: [
        { short_id: "ct-6", status: "open" },
        { short_id: "ct-7", status: "open" },
        { short_id: "ct-8", status: "open" },
        { short_id: "ct-9", status: "done" },
      ] } },
      // Freed: its only blocker was the task that just closed.
      "ct-6": { short_id: "ct-6", status: "open", links: { blocked_by: [{ kind: "task", ref: "ct-5", status: "done" }] } },
      // Still held by a second blocker, so the close freed nothing here.
      "ct-7": { short_id: "ct-7", status: "open", links: { blocked_by: [{ kind: "task", ref: "ct-5", status: "done" }, { kind: "task", ref: "ct-4", status: "open" }] } },
      // An older plan row names its blocker by `_id`; the same task.
      "ct-8": { short_id: "ct-8", status: "in_progress", links: { blocked_by: [{ kind: "task", ref: "id_ct-5", status: "done" }] } },
    });
    const r = await releasedByClose(deps, "ct-5");
    expect(r).toEqual({ freed: [{ short_id: "ct-6", status: "open" }, { short_id: "ct-8", status: "in_progress" }], more: 0 });
    // A closed dependent is never read: nothing holds it and nothing is news.
    expect(asked).toEqual(["ct-5", "ct-6", "ct-7", "ct-8"]);
    // Only the open one is claimable; the one being worked already has someone.
    expect(releasedByCloseLine("ct-5", r)).toBe("Unblocked: ct-6, ct-8; cast task start ct-6 takes it");
  });

  test("a stale blocks mirror claims no release, and a refused read says nothing at all", async () => {
    const { deps } = readDeps({
      "ct-5": { short_id: "ct-5", status: "done", links: { blocks: [{ short_id: "ct-6", status: "open" }] } },
      // The edge is gone from the dependent's own side, so this close did not
      // free it, whatever the mirror still says.
      "ct-6": { short_id: "ct-6", status: "open", links: { blocked_by: [] } },
    });
    expect(await releasedByClose(deps, "ct-5")).toEqual({ freed: [], more: 0 });
    expect(releasedByCloseLine("ct-5", { freed: [], more: 0 })).toBeNull();
    const { deps: blind } = readDeps({});
    expect(await releasedByClose(blind, "ct-5")).toEqual({ freed: [], more: 0 });
  });

  test("more dependents than one read can judge are counted, never claimed", async () => {
    const blocks = ["ct-6", "ct-7"].map((short_id) => ({ short_id, status: "open" }));
    const { deps, asked } = readDeps({
      "ct-5": { short_id: "ct-5", status: "done", links: { blocks } },
      "ct-6": { short_id: "ct-6", status: "open", links: { blocked_by: [{ kind: "task", ref: "ct-5", status: "done" }] } },
      "ct-7": { short_id: "ct-7", status: "open", links: { blocked_by: [{ kind: "task", ref: "ct-5", status: "done" }] } },
    });
    const r = await releasedByClose(deps, "ct-5", { cap: 1 });
    expect(asked).toEqual(["ct-5", "ct-6"]);
    expect(releasedByCloseLine("ct-5", r)).toBe("Unblocked: ct-6; cast task start ct-6 takes it (1 more it blocked was not read: cast task show ct-5)");
  });
});

describe("removalVerdict", () => {
  test("the work can go on when someone holds it, the server's reason wins over the claim, and a closed task gets no verdict", () => {
    expect(removalVerdict("ct-5", { status: "in_progress" }, [])).toEqual(["ct-5 is unblocked, so the work can go on"]);
    // `not_ready` is the half of the answer no blocker list holds, and it is
    // the reason the claim command would not be given.
    expect(removalVerdict("ct-5", { status: "open", not_ready: "parent_active" }, []))
      .toEqual(["ct-5 is unblocked", "Not ready: its parent is being worked"]);
    // Nothing holds a closed task whatever its rows still say (TG1), so the
    // removal was bookkeeping on history and claims nothing.
    expect(removalVerdict("ct-5", { status: "done" }, [])).toEqual([]);
    // No read, no claim.
    expect(removalVerdict("ct-5", null, [])).toEqual([]);
    // Red CI reads as red here as everywhere else (TG10).
    expect(removalVerdict("ct-5", { status: "open" }, [{ ...prWait("waiting"), kind: "pr_checks_green", checks: "failure" } as any]))
      .toEqual(["ct-5 is still blocked by PR #42 checks failing"]);
  });
});

describe("taskGraphSections", () => {
  test("the web's order and words, waits after tasks, empty sections left out", () => {
    const sections = taskGraphSections(
      { blocked_by: ["ct-1", "ct-2", "ct-3"], waits: [prWait("waiting"), prWait("failed", "closed without merging", 7)] },
      {
        blocked_by: [
          { kind: "task", ref: "ct-1", title: "Design", status: "done" },
          { kind: "task", ref: "ct-2", missing: true },
          { kind: "task", ref: "ct-3", status: "unknown" },
        ],
        blocks: [{ short_id: "ct-9", title: "Ship", status: "open" }],
        found_during: { short_id: "ct-4", title: "Audit", status: "in_progress" },
        found_here: [],
        related: [{ short_id: "ct-6", title: "Docs", status: "open" }],
        superseded_by: null,
      },
    );
    expect(sections).toEqual([
      {
        label: "Blocked by",
        holds: true,
        items: ["ct-1 Design [done]", "ct-2 (not found)", "ct-3 (status unknown)", "PR #42 to merge [waiting]", "PR #7 closed without merging [failed]"],
      },
      { label: "Blocks", items: ["ct-9 Ship [open]"] },
      { label: "Found during", items: ["ct-4 Audit [in_progress]"] },
      { label: "Related", items: ["ct-6 Docs [open]"] },
    ]);
  });

  test("nothing holds once every task closed and every wait met", () => {
    const [s] = taskGraphSections({ waits: [prWait("met", "merged")] }, { blocked_by: [{ kind: "task", ref: "ct-1", title: "A", status: "dropped" }] });
    expect(s.holds).toBe(false);
    expect(s.label).toBe("Blocked by (cleared)");
    expect(s.items).toEqual(["ct-1 A [dropped]", "PR #42 merged [met]"]);
  });

  test("a missing task holds nothing; only a time wait carries its id, in the reader's style", () => {
    const words = { waitId: (x: string) => `<${x}>`, now: NOW };
    const [s] = taskGraphSections({ waits: [prWait("waiting")] }, { blocked_by: [{ kind: "task", ref: "ct-2", missing: true }] }, words);
    expect(s.holds).toBe(true);
    // A PR or decision wait is removed by its target (waitRemoveRef), so its
    // internal id is noise on the line; a time wait's id is the handle.
    expect(s.items[1]).toBe("PR #42 to merge [waiting]");
    expect(taskGraphSections({ waits: [{ kind: "decision", decision: "sd-4", id: "wq7z", state: "waiting", created_at: NOW }] }, null, words)[0].items)
      .toEqual(["sd-4 to be answered [waiting]"]);
    expect(taskGraphSections({ waits: [{ kind: "time", at: NOW + 7_200_000, id: "wt1", state: "waiting", created_at: NOW }] }, null, words)[0].items)
      .toEqual(["14:00 (in 2h) [waiting]< · id wt1>"]);
    expect(taskGraphSections({}, { blocked_by: [{ kind: "task", ref: "ct-2", missing: true }] })[0].holds).toBe(false);
  });

  test("a mixed list marks every entry, so a met or failed wait is not read as holding", () => {
    const [s] = taskGraphSections(
      { waits: [prWait("waiting", undefined, 8), { ...prWait("met", "checks green", 8), kind: "pr_checks_green", id: "w8c" }, prWait("failed", "closed without merging", 9)] },
      { blocked_by: [{ kind: "task", ref: "ct-1", title: "A", status: "open" }] },
    );
    // Every line ends in a bracketed state, the way a task blocker does: the
    // two #8 waits differ only by tense otherwise ("to merge" / "checks green").
    expect(s.items).toEqual([
      "ct-1 A [open]",
      "PR #8 to merge [waiting]",
      "PR #8 checks green [met]",
      "PR #9 closed without merging [failed]",
    ]);
    expect(s.label).toBe("Blocked by");
  });

  test("a checks wait reads by its PR's checks, so red CI is as visible here as on the page", () => {
    const checks = { ...prWait("waiting", undefined, 42), kind: "pr_checks_green" as const, id: "w42c" };
    const row = { waits: [checks, prWait("waiting", undefined, 42)] };
    const links = { blocked_by: [], wait_checks: { w42c: "failure" } };
    // Red checks keep the wait waiting forever (TG2), so the agent told to
    // park on it reads the same word the task page and the phone show.
    expect(taskGraphSections(row, links)[0].items).toEqual(["PR #42 checks failing [waiting]", "PR #42 to merge [waiting]"]);
    expect(taskGraphSections(row, { blocked_by: [], wait_checks: { w42c: "pending" } })[0].items[0]).toBe("PR #42 checks running [waiting]");
    // Nothing read, or green: the wait says what it waits for.
    expect(taskGraphSections(row, { blocked_by: [] })[0].items[0]).toBe("PR #42 checks to go green [waiting]");
  });

  // TG10: the surface that orders a session dormant must not be the one that
  // cannot see red CI. `cast task context` prints the parking line directly
  // under these Blocked by lines, and `cast task dep` builds the same sentence
  // from the same list, so the checks state rides on the entry rather than
  // beside it.
  test("the parking line under the Blocked by lines knows the checks are red", () => {
    const checks = { ...prWait("waiting", undefined, 42), kind: "pr_checks_green" as const, id: "w42c" };
    const row = { status: "in_progress", waits: [checks] };
    const links = { blocked_by: [], wait_checks: { w42c: "failure" } };
    expect(holdingBlockers(row, links)).toEqual([{ ...checks, checks: "failure" }]);
    const park = parkAfterBlocking("s1", "ct-5", holdingBlockers(row, links), { task: "ct-5", started: true });
    expect(park).toContain("Checks are failing on PR #42 now, so only a new push turns them green");
    // Green, or never read: nothing to warn about, and the pin stands alone.
    expect(parkAfterBlocking("s1", "ct-5", holdingBlockers(row, { blocked_by: [] }), { task: "ct-5", started: true }))
      .not.toContain("Checks are failing");
  });

  test("a closed task waits on nothing, whatever its rows still say", () => {
    // Nothing clears a wait on close (settleWaits returns early for a terminal
    // task), so a done task routinely keeps a `waiting` one. Every other
    // surface drops it: tasks.list returns no open_blockers for a terminal row,
    // the web offers no adds and the phone drops the word. The text list says
    // the same — the bare subject marked as history, no "to merge", and "cleared".
    const row = { status: "done", waits: [prWait("waiting")] };
    const [s] = taskGraphSections(row, { blocked_by: [{ kind: "task", ref: "ct-1", title: "A", status: "open" }] });
    expect(s.label).toBe("Blocked by (cleared)");
    expect(s.holds).toBe(false);
    // The task blocker's bracket is the one that looks identical to a live
    // hold, so it carries the same marker the waits do.
    expect(s.items).toEqual(["ct-1 A [open, history]", "PR #42 [history]"]);
    // Two waits on one PR would otherwise print the same line, with no way to
    // tell which handle clears which: the checks one keeps its `:checks`.
    expect(taskGraphSections({ status: "done", waits: [prWait("waiting"), { ...prWait("waiting"), id: "w42c", kind: "pr_checks_green" }] }, null)[0].items)
      .toEqual(["PR #42 [history]", "PR #42:checks [history]"]);
    // So the parking line `cast task context` closes its Graph with is not armed.
    expect(holdingBlockers(row, null)).toEqual([]);
    expect(parkAfterBlocking("s1", "ct-5", holdingBlockers(row, null), { task: "ct-5", started: true })).toBeNull();
    // A time wait's countdown goes with it; its removal handle stays.
    expect(taskGraphSections({ status: "dropped", waits: [{ kind: "time", at: NOW + 7_200_000, id: "wt1", state: "waiting", created_at: NOW }] }, null, { now: NOW })[0].items)
      .toEqual(["14:00 [history] · id wt1"]);
    // A blocker that holds nothing by its own status is already history.
    expect(taskGraphSections({ status: "done" }, { blocked_by: [{ kind: "task", ref: "ct-1", title: "A", status: "done" }] })[0].items)
      .toEqual(["ct-1 A [done]"]);
    // An open task is unchanged.
    expect(taskGraphSections({ status: "open", waits: [prWait("waiting")] }, null)[0]).toEqual({ label: "Blocked by", holds: true, items: ["PR #42 to merge [waiting]"] });
  });

  test("the replacement is its own line, never a section after the rest", () => {
    const links = { superseded_by: { short_id: "ct-12", title: "New plan", status: "open" } };
    expect(taskGraphSections({}, links)).toEqual([]);
    expect(supersededLine(links)).toBe("Superseded by: ct-12 New plan [open]");
    expect(supersededLine({ superseded_by: null })).toBeNull();
  });

  test("a server without links still lists the raw ids", () => {
    expect(taskGraphSections({ blocked_by: ["ct-1"], blocks: ["ct-2"] }, undefined)).toEqual([
      { label: "Blocked by", holds: true, items: ["ct-1 (status unknown)"] },
      { label: "Blocks", items: ["ct-2"] },
    ]);
  });
});

describe("plan steps", () => {
  test("stepsFromText refuses an empty list with the form", () => {
    expect(() => stepsFromText("\n \n")).toThrow(/blank line between waves/);
    expect(stepsFromText("A\n\nB\nC").map((s) => s.after)).toEqual([[], [0], [0]]);
    expect(() => stepsFromText("1. Design\n2. Build\n3. Review")).toThrow(/Numbered steps on consecutive lines run in parallel/);
    expect(stepsFromText("1. Design\n\n2. Build").map((s) => s.after)).toEqual([[], [0]]);
  });

  test("stepsFromTemplate keeps only backward edges", () => {
    const steps = stepsFromTemplate({ task_templates: [{ title: "A" }, { title: "B", blocked_by_indices: [0, 1, 5] }] });
    expect(steps).toEqual([{ title: "A", after: [] }, { title: "B", after: [0] }]);
  });

  function fakeDeps(templates: unknown[] = [], here: Awaited<ReturnType<GraphDeps["workspace"]>> = { workspace: "personal" }) {
    const calls: Array<{ path: string; body: Record<string, any> }> = [];
    let n = 100;
    const deps: GraphDeps = {
      cliPost: async (path, body) => {
        calls.push({ path, body });
        if (path === "/cli/work/create") return { short_id: `ct-${++n}` };
        if (path === "/cli/plans/templates") return templates;
        return {};
      },
      sessionId: () => null,
      cwd: () => "/repo",
      printJson: () => {},
      workspace: async () => here,
      // The real resolver over a one-team roster, the way index.ts wires it.
      namedScope: async (scope) => namedWorkspace({ teams: [{ _id: "team_a", name: "Acme" }], activeTeamId: null }, workspaceOfScope(scope)),
    };
    return { deps, calls };
  }

  test("createPlanSteps wires waves; the first wave waits on the roots", async () => {
    const { deps, calls } = fakeDeps();
    const created = await createPlanSteps(deps, "pl-1", stepsFromText("Design\n\nAPI\nUI\n\nReview"), { roots: ["ct-7"], base: { source: "agent" } });
    expect(created.map((c) => [c.short_id, c.blocked_by])).toEqual([
      ["ct-101", ["ct-7"]],
      ["ct-102", ["ct-101"]],
      ["ct-103", ["ct-101"]],
      ["ct-104", ["ct-102", "ct-103"]],
    ]);
    expect(calls[0].body).toMatchObject({ title: "Design", plan_id: "pl-1", found_during: "none", source: "agent", blocked_by: ["ct-7"] });
    expect("after" in calls[0].body).toBe(false);
  });

  const stepsOf = async (deps: GraphDeps, name: string) => (await planTemplate(deps, name)).steps;

  test("planTemplate: built-ins chain, saved ones by name in any case, unknown lists both", async () => {
    const saved = [{ name: "Release train", goal_template: "Ship weekly", task_templates: [{ title: "Cut" }, { title: "Ship", blocked_by_indices: [0] }] }];
    const { deps } = fakeDeps(saved);
    expect((await stepsOf(deps, "Implement-Review-Fix")).map((s) => s.after)).toEqual([[], [0], [1], [2]]);
    expect((await stepsOf(deps, "release TRAIN")).map((s) => [s.title, s.after])).toEqual([["Cut", []], ["Ship", [0]]]);
    await expect(stepsOf(deps, "nope")).rejects.toThrow(/full-lifecycle, "Release train"/);
  });

  test("planTemplate: a saved template brings its plan's goal; a built-in has none", async () => {
    const { deps } = fakeDeps([{ name: "Release train", goal_template: "Ship weekly", task_templates: [{ title: "Cut" }] }]);
    expect((await planTemplate(deps, "release train")).goal).toBe("Ship weekly");
    expect((await planTemplate(deps, "full-lifecycle")).goal).toBeUndefined();
  });

  test("planTemplate: a name saved in several workspaces takes this one's, and refuses a guess", async () => {
    const saved = [
      { name: "Release", team_id: "team_a", task_templates: [{ title: "A" }] },
      { name: "release", task_templates: [{ title: "Personal" }] },
    ];
    expect((await stepsOf(fakeDeps(saved, { workspace: "team", team_id: "team_a" }).deps, "RELEASE")).map((s) => s.title)).toEqual(["A"]);
    expect((await stepsOf(fakeDeps(saved).deps, "release")).map((s) => s.title)).toEqual(["Personal"]);
    await expect(stepsOf(fakeDeps(saved, { workspace: "team", team_id: "team_b" }).deps, "release")).rejects.toThrow(/none of them this one/);
  });

  test("planStepBase stamps steps with the plan's origin and workspace", async () => {
    const { deps } = fakeDeps();
    expect(planStepBase(deps, { human: true })).toEqual({ project_path: "/repo", source: "human" });
    expect(planStepBase({ ...deps, sessionId: () => "sess" })).toEqual({ project_path: "/repo", source: "agent", conversation_id: "sess" });
    expect(planStepBase(deps, { human: true, plan: { workspace: "team:t1", team_id: "t1" } })).toMatchObject({ workspace: "team", team_id: "t1" });
    // `cast plan steps` closes with `cast task ready --plan … --team <name>`,
    // scoped from this same base: the base is route-arg form (namedScope's
    // input), not the plan's stored key, and a bare Convex id in a pasted
    // command reads as a blob.
    expect(teamFlagFor(await deps.namedScope(planStepBase(deps, { plan: { workspace: "team:team_a", team_id: "team_a" } }))))
      .toBe(" --team Acme");
  });

  // The command that files a plan's steps is the one the cast-plan skill runs,
  // and that skill's own rule is to report the plan and stop: the human
  // approves it before anything is implemented. So the claim is staged as a
  // later action rather than printed as this turn's next one.
  test("the closing line stages the claim instead of ordering it", () => {
    const line = planStepsNextAction("pl-851", " --team Codecast");
    expect(line).toContain("When execution starts,");
    expect(line).toContain("cast task ready --plan pl-851 --team Codecast --claim");
    expect(line.startsWith("When execution starts,")).toBe(true);
  });

  test("planStepBase files steps in the plan's project, under the session the plan was stamped with", () => {
    const { deps } = fakeDeps();
    expect(planStepBase(deps, { human: true, plan: { project_id: "proj1" } })).toEqual({ project_path: "/repo", project_id: "proj1", source: "human" });
    // plan create detected a session the deps would not guess: the steps follow the plan.
    expect(planStepBase(deps, { sessionId: "guessed" })).toEqual({ project_path: "/repo", source: "agent", conversation_id: "guessed" });
    expect(planStepBase({ ...deps, sessionId: () => "sess" }, { sessionId: null, human: true })).toEqual({ project_path: "/repo", source: "human" });
  });

  test("planWorkspace reads the plan's access key, else its legacy team", () => {
    expect(planWorkspace({ workspace: "team:t1" })).toEqual({ workspace: "team", team_id: "t1" });
    expect(planWorkspace({ workspace: "user:u1", team_id: "t1" })).toEqual({ workspace: "personal" });
    expect(planWorkspace({ team_id: "t2" })).toEqual({ workspace: "team", team_id: "t2" });
    expect(planWorkspace(undefined)).toEqual({});
    // A key this CLI cannot read names nothing, the way it grants nothing: it
    // never falls through to the routing team, which is not access.
    expect(planWorkspace({ workspace: "restricted:r1", team_id: "t1" })).toEqual({});
  });

  test("createPlanSteps: a refused step names what was filed and how to add the rest", async () => {
    let n = 0;
    const deps: GraphDeps = {
      ...fakeDeps().deps,
      cliPost: async () => {
        if (++n === 3) throw new Error("Plan is in another workspace");
        return { short_id: `ct-${n}` };
      },
    };
    // C and D share a wave with the filed A and B: each is created on its own,
    // since appending would make them wait on A and B.
    await expect(createPlanSteps(deps, "pl-1", stepsFromText("A\nB\nC :: it's done\nD"))).rejects.toThrow(
      'Plan is in another workspace\n2 of 4 steps filed (ct-1, ct-2); "C" and the steps after it were not. Add them with:\n'
        + "  cast task create 'C' --plan pl-1 --found-during none -d 'it'\\''s done'\n"
        + "  cast task create 'D' --plan pl-1 --found-during none",
    );
    // Half of a later wave filed: its rest waits on the wave before; the waves after are appended.
    n = 0;
    const failing: GraphDeps = { ...deps, cliPost: async () => {
      if (++n === 3) throw new Error("refused");
      return { short_id: `ct-${n}` };
    } };
    const err = await createPlanSteps(failing, "pl-1", stepsFromText("Design\n\nAPI\nUI\n\nReview\n\nShip"), { roots: ["ct-0"] }).catch((e) => e.message);
    expect(err).toBe('refused\n2 of 5 steps filed (ct-1, ct-2); "UI" and the steps after it were not. Add them with:\n'
      + "  cast task create 'UI' --plan pl-1 --found-during none --blocked-by ct-1\n"
      + "then the 2 steps after them, which go after the plan's last wave:\n"
      + "cast plan steps pl-1 - <<'STEPS'\nReview\n\nShip\nSTEPS");

    // The advice files where the base did: a person's board, the plan's project and workspace.
    n = 0;
    const base = { source: "human", project_id: "proj1", workspace: "team", team_id: "team_a" };
    const advice = await createPlanSteps(failing, "pl-1", stepsFromText("A\nB\nC\n\nD :: it ships\nE"), { base }).catch((e) => e.message);
    // The team is named from the roster, never printed as its Convex id, and
    // one helper words every printed flag value (flagArg): a bare id carries no
    // quotes, a value that is not one bare word does.
    expect(advice).toContain("  cast task create 'C' --plan pl-1 --found-during none --human --project proj1 --team Acme\n");
    expect(advice).toContain("cast plan steps pl-1 --human - <<'STEPS'\nD :: it ships\nE\nSTEPS");
  });

  test("stepsFromTitles: a step may name one further down; filed tasks and ids ride along; strangers and loops come back", () => {
    const { steps, unknown, loops } = stepsFromTitles(
      [
        { title: "Review", blocked_by: ["Build"] },
        { title: "Build", blocked_by: ["Design", "Schema"] },
        { title: "Design", priority: "high" },
        { title: "Docs", blocked_by: ["ct-77", "Nope"] },
      ],
      new Map([["Schema", "ct-5"]]),
    );
    expect(steps.map((s) => [s.title, s.after, s.blocked_by ?? []])).toEqual([
      ["Design", [], []],
      ["Docs", [], ["ct-77"]],
      ["Build", [0], ["ct-5"]],
      ["Review", [2], []],
    ]);
    expect(steps[0]).toEqual({ title: "Design", priority: "high", after: [] });
    expect(unknown).toEqual([{ step: "Docs", needs: "Nope" }]);
    expect(loops).toEqual([]);
    const looped = stepsFromTitles([{ title: "A", blocked_by: ["B"] }, { title: "B", blocked_by: ["A"] }]);
    expect(looped.loops.length).toBe(1);
    expect(looped.loops[0].sort()).toEqual(["A", "B"]);
    expect(looped.steps.map((s) => s.after)).toEqual([[], [0]]);
  });

  test("createPlanSteps sends a step's filed blockers beside the steps it needs", async () => {
    const sent: any[] = [];
    const deps: GraphDeps = { ...fakeDeps().deps, cliPost: async (_path, body) => { sent.push(body); return { short_id: `ct-${sent.length}` }; } };
    await createPlanSteps(deps, "pl-1", [{ title: "A", after: [] }, { title: "B", after: [0], blocked_by: ["ct-77"] }]);
    expect(sent[1].blocked_by).toEqual(["ct-1", "ct-77"]);
    expect("after" in sent[1]).toBe(false);
  });

  test("offFrontierLines: why ready leaves an open task out, and whose an ephemeral task is", () => {
    expect(offFrontierLines({ status: "open" }, "parent_active")).toEqual(["Not ready: its parent is being worked"]);
    // The one verdict with no fix in its own words gets the command that clears it.
    expect(offFrontierLines({ short_id: "ct-9", status: "open", triage_status: "suggested" }, "triage"))
      .toEqual(["Not ready: not triaged", "cast task promote ct-9 puts it on the frontier"]);
    expect(offFrontierLines({ status: "open", ephemeral: true, created_from_conversation: "c1" }, null)).toEqual(["Ephemeral: only the session that filed it gets it from cast task ready"]);
    expect(offFrontierLines({ status: "done", ephemeral: true }, undefined)).toEqual([]);
    // The Ephemeral line is for the OWNER, whose verdict is `ready`. When
    // "ephemeral" IS the verdict the reader is someone else, and the first line
    // already says whose bookkeeping it is: saying it twice says nothing more.
    expect(offFrontierLines({ status: "open", ephemeral: true, created_from_conversation: "c1" }, "ephemeral"))
      .toEqual(["Not ready: bookkeeping of the session that filed it"]);
  });

  test("planTemplate: your own copy wins; several others' copies are refused by name", async () => {
    const team = { workspace: "team" as const, team_id: "team_a" };
    const saved = [
      { name: "Release", team_id: "team_a", workspace_label: "Acme", author: "Ann", mine: false, task_templates: [{ title: "Ann's" }] },
      { name: "release", team_id: "team_a", workspace_label: "Acme", author: "Me", mine: true, task_templates: [{ title: "Mine" }] },
    ];
    expect((await stepsOf(fakeDeps(saved, team).deps, "release")).map((s) => s.title)).toEqual(["Mine"]);
    const others = [saved[0], { ...saved[1], author: "Bob", mine: false }];
    await expect(stepsOf(fakeDeps(others, team).deps, "release")).rejects.toThrow(/several people in this workspace \(Acme, by Ann; Acme, by Bob\)/);
    await expect(stepsOf(fakeDeps(others).deps, "release")).rejects.toThrow(/other workspaces \(Acme, by Ann; Acme, by Bob\), none of them this one/);
  });
});
