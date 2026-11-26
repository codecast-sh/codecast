import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerFlowCommands, type FlowDeps } from "./flowCommand";
import { stationProgress } from "./flowStations";
import { sessionIdFromEnv } from "./sessionIdentity";

// The change flow's station commands as `cast flow` parses them. The reviewer's
// prompt (templates/change/review.md) has its spawned session run one literal
// line, with the run's $vars expanded and nothing else: no run, no node.

// The line as change/review.md writes it.
const REVIEW_MD_LINE = `cast flow review-verdict --verdict changes --head "$pr.json.head_sha" --round "$pr.json.round"`;

function cast(env: NodeJS.ProcessEnv, cliPost?: FlowDeps["cliPost"]) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const refuse = (what: string) => () => { throw new Error(`the review verdict should not reach ${what}`); };
  const deps: FlowDeps = {
    cliPost: cliPost ?? (async (path, body) => { posts.push({ path, body: structuredClone(body) }); return { run_id: "run_1", node_id: "review__review", attempt: 1 }; }),
    // How `cast` names the session it runs inside: from the agent's own environment.
    callingSession: () => sessionIdFromEnv(env) ?? undefined,
    subjectSession: refuse("subjectSession"),
    realCwd: () => process.cwd(),
    readWorkspace: refuse("readWorkspace"),
    directoryWorkspace: refuse("directoryWorkspace"),
    writeWorkspace: refuse("writeWorkspace"),
    requireFlows: refuse("requireFlows"),
  };
  const program = new Command("cast").exitOverride();
  registerFlowCommands(program, deps);
  return { program, posts };
}

/** The line as the session's shell runs it: the runner expands the prompt's $vars first, then bash splits it. */
function argv(line: string, vars: Record<string, string>): string[] {
  const expanded = line.replace(/\$([a-z_]+(?:\.[a-z_]+)*)/g, (m, name) => vars[name] ?? m);
  const out = spawnSync("bash", ["-c", `printf '%s\\0' ${expanded.replace(/^cast /, "")}`], { encoding: "utf-8" }).stdout;
  return out.split("\0").filter(Boolean);
}

describe("cast flow review-verdict", () => {
  test("review.md's literal line, from a spawned reviewer session, records the verdict naming only the session", async () => {
    const head = "c".repeat(40);
    const { program, posts } = cast({ CLAUDE_CODE_SESSION_ID: "rev-agent-uuid" });
    await program.parseAsync(["node", "cast", ...argv(REVIEW_MD_LINE, { "pr.json.head_sha": head, "pr.json.round": "r2" })]);
    expect(posts).toEqual([{ path: "/cli/workflow-runs/review-verdict", body: { session_id: "rev-agent-uuid", verdict: "changes", head_sha: head, round: "r2" } }]);
  });

  test("--run and --node pass through when a session must name them", async () => {
    const { program, posts } = cast({ CODECAST_SESSION_ID: "rev-agent-uuid" });
    await program.parseAsync(["node", "cast", "flow", "review-verdict", "--verdict", "ship", "--head", "d".repeat(40), "--run", "run_9", "--node", "review__review"]);
    expect(posts[0].body).toEqual({ session_id: "rev-agent-uuid", verdict: "ship", head_sha: "d".repeat(40), run_id: "run_9", node_id: "review__review" });
  });
});

describe("cast flow record-pr and record-rebase", () => {
  test("a repository's own station scripts record its pull request and rebases on $run_id, and a failed report only prints", async () => {
    const head = "e".repeat(40);
    const rebased = "f".repeat(40);
    const line = ["node", "cast", "flow", "record-pr", "--number", "4923", "--head", head, "--repository", "Acme-AI/Acme-Mobile"];
    const rebaseLine = ["node", "cast", "flow", "record-rebase", "--from", head, "--to", rebased];
    const { program, posts } = cast({});
    const logged: string[] = [];
    const error = console.error;
    const runId = process.env.run_id;
    console.error = (l: string) => { logged.push(l); };
    process.env.run_id = "run_7";
    try {
      await program.parseAsync(line);
      await program.parseAsync(rebaseLine);
      expect(posts).toEqual([
        { path: "/cli/workflow-runs/pr", body: { run_id: "run_7", repository: "Acme-AI/Acme-Mobile", number: 4923, head_sha: head } },
        { path: "/cli/workflow-runs/rebase", body: { run_id: "run_7", from: head, to: rebased } },
      ]);

      const refused = cast({}, async (path) => { throw new Error(`${path} answered 502`); });
      await refused.program.parseAsync(line);
      await refused.program.parseAsync(rebaseLine);
      expect(logged).toEqual([
        "the pull request was not recorded on the run: /cli/workflow-runs/pr answered 502",
        "the rebase was not recorded on the run: /cli/workflow-runs/rebase answered 502",
      ]);
    } finally {
      console.error = error;
      if (runId === undefined) delete process.env.run_id; else process.env.run_id = runId;
    }
  });
});

describe("a waiting station's progress", () => {
  test("a post the server answers with a 502 is logged, and the wait goes on", async () => {
    const asked: Array<{ throwOnError?: boolean }> = [];
    // As the CLI's cliPost does: without throwOnError an error reply exits the process.
    const cliPost: FlowDeps["cliPost"] = async (_path, _body, opts) => {
      asked.push({ throwOnError: opts?.throwOnError });
      if (!opts?.throwOnError) throw new Error("process.exit(1)");
      throw new Error("/cli/workflow-runs/progress answered 502 with a page that is not JSON");
    };
    const logged: string[] = [];
    const error = console.error;
    console.error = (line: string) => { logged.push(line); };
    try {
      const say = stationProgress({ cliPost }, "run_1", "wait_main");
      say("Main CI is red at 9f8e7d6: test-web; looking again in 60s");
      say("Main CI is still red");
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      console.error = error;
    }
    expect(asked).toEqual([{ throwOnError: true }, { throwOnError: true }]);
    expect(logged).toEqual([
      "Main CI is red at 9f8e7d6: test-web; looking again in 60s (not posted to the run: /cli/workflow-runs/progress answered 502 with a page that is not JSON)",
      "Main CI is still red (not posted to the run: /cli/workflow-runs/progress answered 502 with a page that is not JSON)",
    ]);
  });
});

describe("cast flow verdicts and a carried ship", () => {
  test("a ship carried in pr.json counts only as the server's merge-proof for the run holds it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-flow-verdicts-"));
    const head = "a".repeat(40);
    // No branch: Verdicts asks origin nothing.
    fs.writeFileSync(path.join(dir, "pr.json"), JSON.stringify({ url: "u", number: 7, head_sha: head, round: "r2", reviewed: { verdict: "ship", head_sha: head } }, null, 2));
    fs.writeFileSync(path.join(dir, "ci.json"), JSON.stringify({ green: true, head_sha: head, failing: [], preexisting: [], pending: [], timed_out: false }));
    const said: string[] = [];
    const log = console.log;
    console.log = (l: string) => { said.push(l); };
    try {
      for (const held of [{ verdict: "ship", head_sha: head }, { verdict: "changes", head_sha: head }]) {
        const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
        const { program } = cast({}, async (p, body) => { posts.push({ path: p, body }); return { review: held, rebases: [] }; });
        await program.parseAsync(["node", "cast", "flow", "verdicts", "--dir", dir, "--run", "run_3"]);
        expect(posts).toEqual([{ path: "/cli/workflow-runs/merge-proof", body: { run_id: "run_3" } }]);
      }
    } finally {
      console.log = log;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(said.map((l) => JSON.parse(l).next)).toEqual(["merge", "rerun_review"]);
  });
});
