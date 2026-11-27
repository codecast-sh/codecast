import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchRuns, formatRunDetail, restartHint, runByRef, slimRun, stopWords, type RunListRow } from "./runsCli.js";

const SITE = "https://x.test";
const deps = { getCliEndpoint: () => ({ siteUrl: SITE, apiToken: "t" }), detectCurrentSessionId: () => null } as any;

describe("workflow run rows", () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let answer: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown } = () => ({ json: {} });
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
      const path = String(url).slice(SITE.length);
      const { api_token: _t, ...body } = JSON.parse(String(init.body));
      calls.push({ path, body });
      const a = answer(path, body);
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const heavy = { _id: "r1", status: "failed", created_at: 0, updated_at: 0, graph_nodes: [{ id: "a", h: "x" }], node_statuses: [{ node_id: "a", status: "completed", session_id: "jx1", session: { state: "y".repeat(5000) } }] };

  test("the list asks for slim rows", async () => {
    answer = () => ({ json: { runs: [slimRun(heavy)] } });
    const rows = await fetchRuns(deps, { task_id: "ct-1", limit: 1 });
    expect(calls[0].body).toEqual({ task_id: "ct-1", limit: 1, slim: true });
    expect(rows[0].node_statuses?.[0]).toEqual({ node_id: "a", status: "completed", session_id: "jx1" });
  });

  test("a backend from before slim is asked again without it, and its rows are slimmed here", async () => {
    answer = (_p, body) => (body.slim ? { status: 500, json: { error: "ArgumentValidationError: Object contains extra field `slim` that is not in the validator." } } : { json: { runs: [heavy] } });
    const rows = await fetchRuns(deps, { task_id: "ct-1" });
    // A read retries once on an error, so the slim ask may go twice before the plain one.
    expect(calls[0].body.slim).toBe(true);
    expect(calls[calls.length - 1].body.slim).toBeUndefined();
    expect(rows[0]).not.toHaveProperty("graph_nodes");
    expect(rows[0].node_statuses?.[0]).not.toHaveProperty("session");
    expect(JSON.stringify(rows).length).toBeLessThan(400);
  });

  test("--sessions keeps the station sessions", async () => {
    answer = () => ({ json: { runs: [heavy] } });
    const rows = await fetchRuns(deps, { task_id: "ct-1" }, { sessions: true });
    expect(calls[0].body.slim).toBeUndefined();
    expect(rows[0].node_statuses?.[0]).toHaveProperty("session");
  });

  test("a run id on a backend that lists by task only is read through the owner's get", async () => {
    answer = (path, body) =>
      path === "/cli/workflow-runs/get" ? { json: { run: heavy } } : body.slim ? { status: 500, json: { error: "Object contains extra field `slim`" } } : { json: { runs: [] } };
    const row = await runByRef(deps, "th7abc");
    expect(row?._id).toBe("r1");
    expect(row).not.toHaveProperty("graph_nodes");
    expect(calls[0].path).toBe("/cli/workflow-runs/list");
    expect(calls[calls.length - 1].path).toBe("/cli/workflow-runs/get");
  });
});

test("the detail names each station with its label, time, outcome and session, and marks where the run stands", () => {
  const now = 10 * 60_000;
  const run: RunListRow = {
    _id: "r1", status: "running", task_short_id: "ct-9", workflow_label: "Fix flow", runner_device: "dev-123", current_node_id: "build",
    created_at: 0, updated_at: now,
    node_statuses: [
      { node_id: "triage", status: "completed", outcome: "success", started_at: 0, completed_at: 90_000, session_id: "jx7a" },
      { node_id: "build", status: "running", started_at: 5 * 60_000, visits: 2 },
    ],
  };
  const out = formatRunDetail(run, new Map([["triage", "Triage"], ["build", "Build"]]), now);
  expect(out).toContain("Fix flow ct-9  running  r1");
  expect(out).toContain("machine dev-123");
  expect(out).toMatch(/triage \(Triage\)\s+completed, 2m, outcome success, session jx7a/);
  expect(out).toMatch(/build \(Build\)\s+running, 5m so far, 2 visits <$/m);
  expect(formatRunDetail({ ...run, status: "failed", fail_reason: "verify exited 1" }, new Map(), now)).toContain("failed: verify exited 1");
});

// ct-102369: the session, `cast workflow show` and the run page each said a different restart for the same stop.
test("a failed run's restart is the one its stop names in the graph's words, else a fresh run of a change, else a resume", async () => {
  const change = { task_short_id: "ct-9", workflow_slug: "change", takes_change: true };
  expect(restartHint(change, await stopWords({ workflow_slug: "change", current_node_id: "noci" }))).toBe("resume it: cast workflow resume ct-9 --at pr");
  // A reviewer's finding quoted into a stop's reason names no resume: only the graph's own words do.
  const rejected = await stopWords({ workflow_slug: "change", current_node_id: "rejected" });
  expect(rejected).not.toContain("cast workflow resume");
  expect(restartHint(change, rejected)).toBe("once the change is fixed, run it again: cast flow run change --task ct-9");
  // Never a literal placeholder: the station it stopped at, else its start; a run with no task says it cannot resume.
  expect(restartHint({ task_short_id: "ct-9", workflow_slug: "line", current_node_id: "build" }, null)).toBe("try it again from where it stopped: cast workflow resume ct-9 --at build");
  expect(restartHint({ task_short_id: "ct-9", workflow_slug: "line" }, null)).toBe("try it again from its start: cast workflow resume ct-9 --at start");
  expect(restartHint({ workflow_slug: "line", current_node_id: "build" }, null)).toBe("it is bound to no task, so it cannot be resumed: start it again");
});

// ct-102477: a refreeze refused a worktree something rebased; the session heard one restart, show printed "<station>".
test("a stop whose runner words name its restart prints that restart, the one the session heard", async () => {
  const { worktreeMovedRestart, worktreeMovedRestartWords, worktreeMovedWords } = await import("@codecast/shared/contracts/runRestart");
  const { runEndMessage } = await import("./subjectStation.js");
  const command = worktreeMovedRestart("change", "ct-9", "codecast/change-ct-9");
  const fail_reason = `Could not freeze session jx7cgvq's change again: ${worktreeMovedWords("d87da407ea0000", "61d7c6b4cb0000")}. ${worktreeMovedRestartWords(command)}`;
  const run = { task_short_id: "ct-9", workflow_slug: "change", takes_change: true, current_node_id: "local_ci_fix", fail_reason };
  expect(restartHint(run, null)).toBe("to ship the run's worktree as it stands now, run it again: cast flow run change --task ct-9 --branch codecast/change-ct-9");
  const told = runEndMessage({ name: "change", label: "Ship" } as any, { taskId: "ct-9", endLabel: "Fix Local CI", failed: true, failReason: fail_reason });
  expect(told).toBe(`The Ship run on ct-9 stopped at Fix Local CI: ${fail_reason}`);
  expect(told).toContain("Something reset or rebased the run's worktree to d87da407ea");
  expect(told).not.toContain("Run it again with `cast flow run change` once it is ready");
  // The same words quoted after another stop's own (a finding that pastes them) name nothing.
  expect(restartHint({ ...run, fail_reason: `Stopped: the reviewer said: ${fail_reason}` }, null)).toBe("once the change is fixed, run it again: cast flow run change --task ct-9");
});

// A flow named change names the library's restart for a stop node it keeps as the library's (same id and label),
// whatever stations it adds (codecast's own variant adds local_ci); a node of its own at that id names none.
test("a variant of change keeps the library's restart at the library's stop nodes; a repo's own node names none", async () => {
  const { BUILTIN_WORKFLOW_TEMPLATES } = await import("./templates.js");
  const { parseWorkflowSource } = await import("./parser.js");
  const shipped = [...parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.change).nodes.values()].map((n) => ({ id: n.id, label: n.label }));
  const noci = { workflow_slug: "change", current_node_id: "noci" };
  expect(await stopWords(noci, shipped)).toContain("--at pr");
  expect(await stopWords(noci, [...shipped, { id: "local_ci", label: "Local CI" }])).toContain("--at pr");
  expect(await stopWords(noci, shipped.map((n) => (n.id === "noci" ? { ...n, label: "Our own stop" } : n)))).toBeNull();
  expect(await stopWords(noci, shipped.filter((n) => n.id !== "noci"))).toBeNull();
  expect(await stopWords(noci, [{ id: "noci", stop: "Own words: `cast workflow resume x --at ci`" }])).toContain("--at ci");
});
