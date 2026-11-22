import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { registerFlowCommands, type FlowDeps } from "./flowCommand";
import { sessionIdFromEnv } from "./sessionIdentity";

// The change flow's station commands as `cast flow` parses them. The reviewer's
// prompt (templates/change/review.md) has its spawned session run one literal
// line, with the run's $vars expanded and nothing else: no run, no node.

// The line as change/review.md writes it.
const REVIEW_MD_LINE = `cast flow review-verdict --verdict changes --head "$pr.json.head_sha" --round "$pr.json.round"`;

function cast(env: NodeJS.ProcessEnv) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const refuse = (what: string) => () => { throw new Error(`the review verdict should not reach ${what}`); };
  const deps: FlowDeps = {
    cliPost: async (path, body) => { posts.push({ path, body: structuredClone(body) }); return { run_id: "run_1", node_id: "review__review", attempt: 1 }; },
    // How `cast` names the session it runs inside: from the agent's own environment.
    callingSession: () => sessionIdFromEnv(env) ?? undefined,
    realCwd: () => process.cwd(),
    readWorkspace: refuse("readWorkspace"),
    directoryTeam: refuse("directoryTeam"),
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
