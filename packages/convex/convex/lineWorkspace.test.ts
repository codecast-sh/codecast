// The line workspace's labels and a station's received input
// (line-workspace.md LW2, LW4): a label lands where its run lives, one per
// person per decision, a null verdict takes it back, and only someone who can
// read the run can label it or read what its station was given.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { stationSaid } from "./lineWorkspace";

const api = anyApi as any;
// convex-test loads the schema and modules on first use, slow on a busy machine.
setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./dispatch.ts": () => import("./dispatch"),
  "./lineWorkspace.ts": () => import("./lineWorkspace"),
};

async function seed() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x" } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@example.com", active_team_id: team } as any);
    const bo = await ctx.db.insert("users", { name: "Bo", email: "bo@example.com", active_team_id: team } as any);
    const eve = await ctx.db.insert("users", { name: "Eve" } as any);
    for (const u of [ana, bo]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    const project = await ctx.db.insert("projects", { title: "Agent Quality", user_id: ana, team_id: team, workspace: `team:${team}`, created_at: now, updated_at: now } as any);
    const task = await ctx.db.insert("tasks", { title: "Cause", short_id: "ct-1", user_id: ana, team_id: team, workspace: `team:${team}`, project_id: project, status: "open", created_at: now, updated_at: now } as any);
    // Ana's station session, private to her: Bo reads it through the run.
    const conv = await ctx.db.insert("conversations", {
      session_id: "sess-dissolve", short_id: "jx7aaaa", user_id: ana, is_private: true, title: "Dissolve", agent_type: "claude_code", status: "completed", message_count: 2, started_at: now, updated_at: now,
    } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "You are the first look at one cluster.\n\nCluster: c-42", timestamp: now + 1 } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Looking.", timestamp: now + 2 } as any);
    const run = await ctx.db.insert("workflow_runs", {
      user_id: ana, task_id: task, status: "completed", workspace: `team:${team}`, team_id: team,
      node_statuses: [{ node_id: "dissolve", status: "completed", session_id: "jx7aaaa", started_at: now, completed_at: now + 60_000 }],
      created_at: now, updated_at: now,
    } as any);
    return { team, ana, bo, eve, project, run, conv };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  const dispatch = (u: string, action: string, args: unknown[]) => as(u).mutation(api.dispatch.dispatch, { action, args });
  return { t, ...ids, as, dispatch };
}

describe("line labels", () => {
  test("a label lands in the run's workspace with its project, one per person, and is read by the team", async () => {
    const { t, team, ana, bo, project, run, as, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "It closed a live cluster"]);
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "right", null]);
    await dispatch(String(bo), "labelDecision", [String(run), "dissolve", "wrong", "Missed the residue"]);
    const rows = await t.run((ctx) => ctx.db.query("line_labels").collect());
    expect(rows).toHaveLength(2);
    const mine = rows.find((r) => String(r.by) === String(ana))!;
    expect(mine).toMatchObject({ workspace: `team:${team}`, team_id: team, project_id: project, node_id: "dissolve", verdict: "right" });
    expect(mine.note).toBeUndefined();

    const read = await as(String(bo)).query(api.lineWorkspace.labels, { team_id: team });
    expect(read.map((r: any) => r.verdict).sort()).toEqual(["right", "wrong"]);
    expect(read.every((r: any) => r.key.startsWith(`${run}:dissolve:`))).toBe(true);
  });

  test("a null verdict takes the viewer's label back and leaves a teammate's", async () => {
    const { t, ana, bo, run, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "x"]);
    await dispatch(String(bo), "labelDecision", [String(run), "dissolve", "right", null]);
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", null, null]);
    const rows = await t.run((ctx) => ctx.db.query("line_labels").collect());
    expect(rows.map((r) => String(r.by))).toEqual([String(bo)]);
  });

  test("someone who cannot read the run can neither label it nor read its labels", async () => {
    const { team, ana, eve, run, as, dispatch } = await seed();
    await dispatch(String(ana), "labelDecision", [String(run), "dissolve", "wrong", "x"]);
    await expect(dispatch(String(eve), "labelDecision", [String(run), "dissolve", "right", null])).rejects.toThrow();
    await expect(as(String(eve)).query(api.lineWorkspace.labels, { team_id: team })).rejects.toThrow();
    expect(await as(String(eve)).query(api.lineWorkspace.labels, {})).toEqual([]);
  });

  test("a step the run never had is refused, and a stub run id is dropped", async () => {
    const { ana, run, dispatch } = await seed();
    await expect(dispatch(String(ana), "labelDecision", [String(run), "nope", "right", null])).rejects.toThrow(/No such step/);
    await expect(dispatch(String(ana), "labelDecision", ["temp_run", "dissolve", "right", null])).resolves.toBeNull();
  });
});

describe("a station's received input", () => {
  test("is its session's first user message, for the owner and for a teammate who reads the run", async () => {
    const { ana, bo, run, conv, as } = await seed();
    const own = await as(String(ana)).query(api.lineWorkspace.stationInput, { conversation_id: conv });
    expect(own).toMatchObject({ _id: String(conv), found: true, truncated: false });
    expect(own.text).toContain("Cluster: c-42");
    expect(await as(String(bo)).query(api.lineWorkspace.stationInput, { conversation_id: conv })).toBeNull();
    const viaRun = await as(String(bo)).query(api.lineWorkspace.stationInput, { conversation_id: conv, run_id: run });
    expect(viaRun?.text).toBe(own.text);
  });

  test("a stranger reads nothing, run or no run", async () => {
    const { eve, run, conv, as } = await seed();
    expect(await as(String(eve)).query(api.lineWorkspace.stationInput, { conversation_id: conv, run_id: run })).toBeNull();
  });
});

describe("a cause's history", () => {
  async function history() {
    const s = await seed();
    const now = Date.now();
    const DAY = 86_400_000;
    const extra = await s.t.run(async (ctx) => {
      const task = (await ctx.db.query("tasks").first())!;
      for (const [i, reopened] of [[30, false], [20, false], [2, true]] as const) {
        await ctx.db.insert("signals", {
          workspace: `team:${s.team}`, source: "agentwatch", kind: "prompt_miss", title: "Persona re-rolled", task_id: task._id, project_id: s.project,
          observed_at: now - i * DAY, created_at: now - i * DAY, ...(reopened ? { reopened: true } : {}),
        } as any);
      }
      // Older than the window: left out.
      await ctx.db.insert("signals", { workspace: `team:${s.team}`, source: "agentwatch", kind: "x", title: "old", task_id: task._id, project_id: s.project, observed_at: now - 400 * DAY, created_at: now - 400 * DAY } as any);
      await ctx.db.patch(s.project, { project_path: "/src/union/outreach" } as any);
      await ctx.db.insert("repo_sources", { user_id: s.ana, team_id: s.team, repository: "Union/Outreach", root: "/src/union", enabled: true, last_synced_at: now, created_at: now, updated_at: now } as any);
      const deploy = (repository: string, team: any, sha: string, at: number) => ctx.db.insert("external_events", {
        team_id: team, source: "codecast", repository, kind: "deploy", title: `backend at ${sha}`, sha, meta: { surface: "backend" }, dedupe_key: `d:${sha}`, created_at: at,
      } as any);
      await deploy("union/outreach", s.team, "abc1234", now - 10 * DAY);
      await deploy("union/outreach", s.team, "commit-not-a-deploy", now - 9 * DAY).then((id) => ctx.db.patch(id, { kind: "commit" } as any));
      // A deploy another team marked on the same repository is theirs.
      const other = await ctx.db.insert("teams", { name: "Other", created_at: now, invite_code: "y" } as any);
      await deploy("union/outreach", other, "fff0000", now - 8 * DAY);
      await deploy("acme/elsewhere", s.team, "eee0000", now - 7 * DAY);
      // The workspace's own source reports its deploys by environment.
      const source = await ctx.db.insert("event_sources", { workspace: `team:${s.team}`, team_id: s.team, owner_user_id: s.ana, short_id: "src-1", provider: "sdk", name: "union", promote: [], status: "active", created_at: now, updated_at: now } as any);
      await ctx.db.insert("external_events", {
        team_id: s.team, workspace: `team:${s.team}`, source: "sdk", kind: "deploy", title: "Deployed 1.2.0 to prod", sha: "abc1234", source_id: source,
        data: { transition: "deploy", source_name: "union", provider: "sdk", release: "1.2.0", environment: "prod" }, dedupe_key: "ingest-deploy", created_at: now - 5 * DAY,
      } as any);
      return { task: task._id };
    });
    return { ...s, ...extra };
  }

  test("occurrences: one row per cause, oldest first, with the reopening ones named", async () => {
    const { bo, eve, project, task, as } = await history();
    const rows = await as(String(bo)).query(api.lineWorkspace.occurrences, { project_id: project });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: String(task), project_id: String(project), sources: ["agentwatch"], capped: false });
    expect(rows[0].observed).toHaveLength(3);
    expect(rows[0].observed[0]).toBeLessThan(rows[0].observed[2]);
    expect(rows[0].reopened).toEqual([rows[0].observed[2]]);
    expect(await as(String(eve)).query(api.lineWorkspace.occurrences, { project_id: project })).toEqual([]);
  });

  test("deploys: the team's markers on the project's repository and its workspace's source, nothing else", async () => {
    const { bo, eve, project, as } = await history();
    const rows = await as(String(bo)).query(api.lineWorkspace.deploys, { project_id: project });
    expect(rows.map((d: any) => [d.via, d.sha, d.surface ?? d.environment])).toEqual([["source", "abc1234", "prod"], ["repository", "abc1234", "backend"]]);
    expect(rows[0]).toMatchObject({ version: "1.2.0", source: "union" });
    // A repository read off the project's merges joins the read.
    const named = await as(String(bo)).query(api.lineWorkspace.deploys, { project_id: project, repositories: ["acme/elsewhere"] });
    expect(named.map((d: any) => d.sha)).toContain("eee0000");
    expect(await as(String(eve)).query(api.lineWorkspace.deploys, { project_id: project })).toEqual([]);
  });

  // LW5: the run that starts on a regressed cause is handed what the earlier attempts did.
  test("a cause's history for its next run: what was found, proposed and shipped, the deploy, and that it came back", async () => {
    const h = await history();
    const now = Date.now();
    const DAY = 86_400_000;
    const shipped = await h.t.run(async (ctx) => {
      await ctx.db.insert("api_tokens", { user_id: h.bo, token_hash: await hashToken("tok-bo"), name: "cli", created_at: now, last_used_at: now } as any);
      await ctx.db.insert("api_tokens", { user_id: h.eve, token_hash: await hashToken("tok-eve"), name: "cli", created_at: now, last_used_at: now } as any);
      const station = (short: string, result: string) => ctx.db.insert("conversations", {
        session_id: `s-${short}`, short_id: short, user_id: h.ana, title: short, agent_type: "claude_code", status: "completed", message_count: 2, started_at: now, updated_at: now, thread_state_result: result,
      } as any);
      await station("jx7inv0", "Named it.\n```json\n{\"outcome\": \"mechanism\", \"statement\": \"The persona block is re-rolled on every follow-up send.\"}\n```");
      await station("jx7pro0", "{\"outcome\": \"proposed\", \"strategy\": \"Pin the persona on the thread's first send.\"}");
      await station("jx7bld0", "{\"outcome\": \"built\", \"summary\": \"Persona stored on the thread and reused.\"}");
      const at = (d: number) => now - d * DAY;
      const run = await ctx.db.insert("workflow_runs", {
        user_id: h.ana, task_id: h.task, status: "completed", workspace: `team:${h.team}`, team_id: h.team,
        node_statuses: [
          { node_id: "investigate", status: "completed", session_id: "jx7inv0", started_at: at(14), completed_at: at(14) },
          { node_id: "propose", status: "completed", session_id: "jx7pro0", started_at: at(13.5), completed_at: at(13.5) },
          { node_id: "build", status: "completed", session_id: "jx7bld0", started_at: at(13), completed_at: at(13) },
          { node_id: "watch", status: "completed", started_at: at(10.5), completed_at: at(10.5) },
        ],
        merge: { sha: "abc1234ffff", branch: "line-ct-1", into: "main", at: at(11), pr_url: "https://github.com/union/outreach/pull/9" },
        created_at: at(15), updated_at: at(10.5),
      } as any);
      await ctx.db.insert("session_decisions", {
        user_id: h.ana, task_id: h.task, workflow_run_id: run, short_id: "sd-9", gate_node_id: "decide", status: "answered", question: "Ship it?", blocking: true,
        options: [{ label: "[S] Ship" }, { label: "[R] Revise" }], answer_index: 0, resolved_at: at(12), created_at: at(12.5), updated_at: at(12),
        card: { headline: "Pin the persona", change: "Pin the persona per thread", wrong: "It re-rolled", recommend: { verdict: "ship", why: "Holds" }, diff: { files: 2, added: 9, removed: 1 } },
      } as any);
      return run;
    });

    const read = await h.t.query(api.lineWorkspace.cliCauseHistory, { api_token: "tok-bo", short_id: "ct-1" });
    expect(read.regressed).toBe(true);
    expect(read.brief).toContain("Found: The persona block is re-rolled on every follow-up send.");
    expect(read.brief).toContain("Proposed: Pin the persona per thread");
    expect(read.brief).toContain("Built: Persona stored on the thread and reused.");
    expect(read.brief).toContain("Card answered Ship");
    expect(read.brief).toMatch(/Deployed to backend and to prod /);
    expect(read.brief).toMatch(/Came back once after the deploy of [A-Z][a-z]{2} \d+ \(first on [A-Z][a-z]{2} \d+\)\. That fix did not hold\./);
    expect(read.earlier).toEqual([expect.objectContaining({ attempt: 1, ref: "sd-9", change: "Pin the persona per thread", held: null })]);

    // The run asking is not its own earlier attempt; a stranger reads nothing.
    const asked = await h.t.query(api.lineWorkspace.cliCauseHistory, { api_token: "tok-bo", short_id: "ct-1", except_run_id: String(shipped) });
    expect(asked.earlier).toEqual([]);
    expect(asked.brief).not.toContain("Pin the persona");
    expect(await h.t.query(api.lineWorkspace.cliCauseHistory, { api_token: "tok-eve", short_id: "ct-1" })).toBeNull();
  });
});

describe("what a station said", () => {
  test("a JSON report reads by its field, prose by its words, a fenced block is left out of prose", () => {
    expect(stationSaid({ session: { result: "{\"strategy\": \"Pin it.\"}" } })).toBe("Pin it.");
    expect(stationSaid({ result_preview: "Named the cause.\n```json\n{\"outcome\": \"failed\"}\n```" })).toBe("Named the cause.");
    expect(stationSaid({ session: { handoff: { note: "Built it." } } })).toBe("Built it.");
    expect(stationSaid({})).toBeNull();
    // A long result is one line, cut at the last sentence that fits.
    const long = stationSaid({ session: { result: `First line.\n\n${"A sentence that goes on. ".repeat(40)}` } })!;
    expect(long).not.toContain("\n");
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith("on.")).toBe(true);
  });
});

describe("a project's line cards", () => {
  test("every card on its causes, answered by anyone, in the card's own words", async () => {
    const { t, ana, bo, eve, project, run, as } = await seed();
    await t.run(async (ctx) => {
      const task = (await ctx.db.query("tasks").first())!;
      await ctx.db.patch(task._id, { cause: { signal_count: 2, first_seen: 1, last_seen: 2, fingerprints: [] } } as any);
      await ctx.db.insert("session_decisions", {
        user_id: ana, task_id: task._id, workflow_run_id: run, short_id: "sd-7", gate_node_id: "decide", status: "answered", question: "Ship it?", blocking: true,
        options: [{ label: "[S] Ship", description: "land it" }, { label: "[R] Revise" }], answer_index: 0, answer_text: "Ship, watch Dana", resolved_at: 5, created_at: 4, updated_at: 5,
        card: { headline: "Pin the sender", change: "Pin it per thread", wrong: "It re-rolled", recommend: { verdict: "ship", why: "Holds" }, diff: { files: 2, added: 9, removed: 1 }, examples: [{ input: "big" }] },
      } as any);
      // A decision with no run is not a line card.
      await ctx.db.insert("session_decisions", { user_id: ana, task_id: task._id, status: "pending", question: "Other?", options: [], created_at: 6, updated_at: 6 } as any);
    });
    const rows = await as(String(bo)).query(api.lineWorkspace.cards, { project_id: project });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ short_id: "sd-7", status: "answered", answer_index: 0, answer_text: "Ship, watch Dana", workflow_run_id: String(run), project_id: String(project) });
    expect(rows[0].card).toEqual({ headline: "Pin the sender", change: "Pin it per thread", wrong: "It re-rolled", recommend: { verdict: "ship", why: "Holds" }, diff: { files: 2, added: 9, removed: 1 } });
    expect(rows[0].options).toEqual([{ label: "[S] Ship" }, { label: "[R] Revise" }]);
    expect(await as(String(eve)).query(api.lineWorkspace.cards, { project_id: project })).toEqual([]);
  });
});
