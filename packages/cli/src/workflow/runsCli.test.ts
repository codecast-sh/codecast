import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchRuns, formatRunDetail, gateAnswers, restartHint, runByRef, slimRun, stopWords, type RunListRow } from "./runsCli.js";

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
  // Local CI still red after the session's turn on it carried on to the PR: no check mark (polish round 6 M1).
  const carried = { ...run, node_statuses: [{ node_id: "local_ci", status: "completed", outcome: "carried", started_at: 0, completed_at: 60_000 }] };
  expect(formatRunDetail(carried, new Map([["local_ci", "Local CI"]]), now)).toMatch(/~ local_ci \(Local CI\)\s+completed, 1m, ended red, carried on$/m);
});

// Polish round 5: ct-102514 read "brief running, 11.7h so far" while its session had asked a person; the run page said so.
test("a station waiting on its session says what it waits on: a person's question, else the session", () => {
  const run: RunListRow = { _id: "r1", status: "running", current_node_id: "brief", created_at: 0, updated_at: 1, node_statuses: [{ node_id: "brief", status: "running", started_at: 0 }],
    waiting_on_session: { node_id: "brief", conversation_id: "jx77vd1wvg6zyaahyvkp7bez4s8k09rm", note: "PR #311 rebased and mergeable; merging waits on your call in sd-5054", blocked: true, since: 0 } };
  expect(formatRunDetail(run, new Map(), 60_000)).toMatch(/brief\s+running, 1m so far <\n\s+.*waiting for a person:.* merging waits on your call in sd-5054 \(asked by session jx77vd1\)$/);
  const fixing = formatRunDetail({ ...run, waiting_on_session: { node_id: "brief", conversation_id: "jx74bpdghknx", note: "## Review asked for changes\n\nShould it sign in?" } }, new Map(), 60_000);
  expect(fixing).toContain("waiting on session jx74bpd: Should it sign in?");
  expect(fixing).not.toContain("a person");
  expect(formatRunDetail({ ...run, waiting_on_session: null }, new Map(), 60_000)).not.toContain("waiting");
});

// Polish round 3: a gate's outcome read "outcome s", the key a person picked; it reads as the option they chose.
test("a gate's outcome reads as the option the person picked", () => {
  const run: RunListRow = { _id: "r1", status: "completed", created_at: 0, updated_at: 1, node_statuses: [{ node_id: "decide__decide", status: "completed", outcome: "s", started_at: 0, completed_at: 60_000 }, { node_id: "merge", status: "completed", outcome: "success", started_at: 0, completed_at: 1 }] };
  const answers = gateAnswers([{ from: "decide__decide", label: "[S] Approve merge :: Merges it; it goes live with the next deploy" }, { from: "decide__decide", label: "[R] Revise :: Your note goes to the session" }, { from: "merge", label: "conflict" }]);
  const out = formatRunDetail(run, new Map(), 60_000, answers);
  expect(out).toMatch(/decide__decide\s+completed, 1m, answered Approve merge/);
  expect(out).toMatch(/merge\s+completed, 0s, outcome success/);
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

// Polish round 6 H1: ct-102786's Merge refused, the Release Captain merged #349, and show still said to ship it again.
test("a run whose pull request was merged outside it names no re-ship", async () => {
  const run = { task_short_id: "ct-9", workflow_slug: "change", takes_change: true, current_node_id: "unshipped", merge: { sha: "fec4c95767", outside: true, by: "captain" }, fail_reason: "Merged by someone else: #349 merged as fec4c95 by captain; going live." };
  expect(restartHint(run, await stopWords(run))).toBe("it is on main as fec4c95, merged outside the run by captain, so running it again lands nothing; where it is live: cast line deploy targets");
});

// Polish round 3 H2: ct-102396 stopped at Deploy failed with its change on main; show said "run it again" while the run
// page offered Open Deploys. The stops are the ones changePage.test.ts opens Deploys on (ct-102256, F3, "a stop at Deploy").
test("a landed run's restart is the deploy that takes it live, as the run page's Open Deploys", async () => {
  const change = { task_short_id: "ct-9", workflow_slug: "change", takes_change: true, current_node_id: "deploy__failed" };
  const stop = await stopWords({ workflow_slug: "change", current_node_id: "deploy__failed" });
  const failed = { ...change, merge: { sha: "929c5d8d44" }, fail_reason: "Stopped: The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.)." };
  expect(restartHint(failed, stop)).toBe("it is on main as 929c5d8, so running it again lands nothing: the next desktop deploy takes it live (cast line deploy targets --target desktop)");
  // The stop's words say it landed even when the row carries no merge, and every failed target is named.
  const two = { ...change, fail_reason: "Stopped: The deploy that carried 929c5d8 failed: desktop dp-3559 (Stopped at Send.), web dp-12. A later deploy that takes it live ends this run at Live." };
  expect(restartHint(two, stop)).toBe("it is on main, so running it again lands nothing: the next desktop and web deploys take it live (cast line deploy targets)");
  const unsent = { ...change, merge: { sha: "929c5d8d44" }, fail_reason: "Stopped: No deploy took 929c5d8 out: cli dp-3789 stopped at Send before sending anything (gh failed). A later deploy that takes it live ends this run at Live." };
  expect(restartHint(unsent, stop)).toBe("it is on main as 929c5d8, so running it again lands nothing: the next cli deploy takes it live (cast line deploy targets --target cli)");
  // A send left to another person's machine (ct-102797's th76kej) goes out with that target's next deploy.
  const away = { ...change, merge: { sha: "ac377bd88f" }, fail_reason: "Stopped: This run could not send mobile: mobile is sent only from Jason Benn's machine (jb-m5-max), not from this machine. ac377bd is on main and goes out with mobile's next deploy." };
  expect(restartHint(away, stop)).toBe("it is on main as ac377bd, so running it again lands nothing: the next mobile deploy takes it live (cast line deploy targets --target mobile)");
  const stuck = { ...change, current_node_id: "deploy__stuck", merge: { sha: "acbd8d27a8" }, fail_reason: "Stopped: Deploy stuck: cli is not live with acbd8d2 after 60m (last: waiting on main CI at c6c7a32 (running)). Live: backend dp-3302." };
  expect(restartHint(stuck, null)).toBe("it is on main as acbd8d2, so running it again lands nothing: the next cli deploy takes it live (cast line deploy targets --target cli)");
  // Every target a stuck stop names, as awaitDeploy joins them.
  const twoStuck = { ...stuck, fail_reason: "Stopped: Deploy stuck: cli is not live with acbd8d2 after 60m (last: sending); web is not live with acbd8d2 after 60m (last: waiting). Live: backend dp-3302." };
  expect(restartHint(twoStuck, null)).toBe("it is on main as acbd8d2, so running it again lands nothing: the next cli and web deploys take it live (cast line deploy targets)");
  // A stop that names no target (ct-64369: cancelled while it waited; a flow may have no deploy targets) says only what is true.
  expect(restartHint({ ...change, current_node_id: "deploy__wait", merge: { sha: "b3e94c2ccd" }, fail_reason: "Cancelled by user" }, null)).toBe("it is on main as b3e94c2, so running it again lands nothing; where it is live: cast line deploy targets");
  // Deploy found no merge: the change is not on main, and a fresh run is the way on.
  expect(restartHint({ ...change, current_node_id: "deploy__unmerged", fail_reason: "Stopped: 929c5d8 is not on main" }, null)).toBe("once the change is fixed, run it again: cast flow run change --task ct-9");
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
  // Words a stage appends after the restart leave it standing; a task id and branch of any shape are read whole.
  const appended = `Could not freeze the checkout's change again: ${worktreeMovedWords("d87da407ea0000", "61d7c6b4cb0000")}. ${worktreeMovedRestartWords(worktreeMovedRestart("our-ship", "TK-12", "fix/a+b_c@2"))} Local CI said: red`;
  expect(restartHint({ ...run, fail_reason: appended }, null)).toBe("to ship the run's worktree as it stands now, run it again: cast flow run our-ship --task TK-12 --branch fix/a+b_c@2");
  expect(runEndMessage({ name: "change", label: "Ship" } as any, { taskId: "ct-9", endLabel: "Fix Local CI", failed: true, failReason: appended })).not.toContain("once it is ready");
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

// Polish round 6 (verifier): a run handed to its role is not "Workflow complete" and its session is not told it is over.
test("a run handed to its role says so in its banner and to its session", async () => {
  const { runEndMessage, completeBanner } = await import("./subjectStation.js");
  const merge = "Merge is @release's: handed to it. @release's merge is off: `cast role line @release --merge on` lets its hands merge.";
  expect(completeBanner(merge)).toBe("Handed to @release");
  expect(completeBanner("Live: abc1234 on cli dp-1.")).toBe("Workflow complete");
  expect(runEndMessage({ name: "change", label: "Ship" } as any, { taskId: "ct-9", endLabel: "Handed to its role", failed: false, lastOutput: merge }))
    .toBe("The Ship run on ct-9 handed its merge to @release: @release's merge is off, so @release merges the change itself. The run ends at Live once that merge goes live; nothing is waiting on this session for it meanwhile.");
});
