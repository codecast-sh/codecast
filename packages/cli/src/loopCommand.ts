// `cast loop`: a session's goal loop (convex sessionGoals.ts, shared/contracts/sessionGoal).
// `cast goal` is the company's goals (initiatives), so the session's own goal
// lives under the loop it drives. The composer's /goal and the goal bar above
// it write the same row.
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { stdinText } from "./sendBody.js";
import { fmt, c } from "./colors.js";
import { commandGroup } from "./commandGroups.js";
import { createInterface } from "node:readline";
import { GOAL_IDLE_LIMIT_MS, GOAL_MAX_ROUNDS, GOAL_MAX_STALLS, goalObjectiveProblem, type SessionGoal } from "@codecast/shared/contracts/sessionGoal";

const STATE_WORD: Record<SessionGoal["status"], string> = { active: "running", paused: "paused", blocked: "blocked", done: "met", cleared: "cleared" };
const STATE_COLOR: Record<SessionGoal["status"], string> = { active: c.cyan, paused: c.yellow, blocked: c.red, done: c.green, cleared: c.dim };

/** The goal as `cast loop show` prints it. */
export function goalLines(shortId: string, goal: SessionGoal | null): string[] {
  if (!goal || goal.status === "cleared") return [fmt.muted(`${shortId} has no goal`)];
  const lines = [
    `${c.cyan}${shortId}${c.reset} ${STATE_COLOR[goal.status]}${STATE_WORD[goal.status]}${c.reset}  round ${goal.rounds}/${goal.max_rounds}${goal.stalls ? `  ${c.yellow}${goal.stalls}/${goal.max_stalls} without progress${c.reset}` : ""}`,
    `  ${goal.objective.replace(/\n/g, "\n  ")}`,
  ];
  if (goal.reason) lines.push(`  ${fmt.muted(goal.status === "active" ? "Missing:" : "Why:")} ${goal.reason}`);
  if (goal.status === "active" && goal.next_step) lines.push(`  ${fmt.muted("Next:")} ${goal.next_step}`);
  return lines;
}

/**
 * Starting or resuming a goal starts agent turns with no person in each round,
 * so it is a person's act: confirmed at a terminal with the caps in view, as
 * the app's review does. An agent's shell has no terminal, so a session cannot
 * start or reset its own loop from here.
 */
async function confirmAtTerminal(what: string, objective: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`cast loop ${what} starts agent turns with no person in each round, so it runs only in a person's terminal. In the app, use /goal in the session's composer.`);
    process.exit(1);
  }
  console.log(`${c.bold}${what === "set" ? "Start goal" : "Resume goal"}${c.reset}  ${objective.split("\n")[0]}`);
  console.log(fmt.muted(`  Up to ${GOAL_MAX_ROUNDS} rounds, pauses after ${GOAL_MAX_STALLS} without progress or ${Math.round(GOAL_IDLE_LIMIT_MS / 60_000)} minutes idle. cast loop pause stops it.`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question("Start it? [y/N] ", resolve));
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(fmt.muted("Not started"));
    process.exit(0);
  }
}

export function registerLoopCommand(program: Command, deps: PublishDeps): void {
  const loop = program.command("loop").description(commandGroup("loop").description);
  const target = (opts: { for?: string }) => {
    const session = opts.for || deps.detectCurrentSessionId();
    if (!session) {
      console.error("No session given and none detected: pass one with --for (cast loop show --for jx7c6zk)");
      process.exit(1);
    }
    return session;
  };
  const print = (row: { short_id: string; goal: SessionGoal | null }, json?: boolean) => {
    if (json) console.log(JSON.stringify(row, null, 2));
    else for (const line of goalLines(row.short_id, row.goal)) console.log(line);
  };

  loop
    .command("set")
    .argument("[objective...]", stdinText("the objective"))
    .description("Give the session a goal: after every turn a review reads what the tools showed and either sends the next step or stops")
    .option("--for <session>", "Target another session (default: the current one)")
    .option("--json", "Machine-readable output")
    .action(async (words: string[], opts: { for?: string; json?: boolean }) => {
      const objective = (words ?? []).join(" ").trim();
      const problem = goalObjectiveProblem(objective);
      if (problem) {
        console.error(problem);
        process.exit(1);
      }
      await confirmAtTerminal("set", objective);
      const row = await apiPost(deps, "/cli/goals/set", { session: target(opts), objective, from_session: deps.detectCurrentSessionId() ?? undefined });
      print(row, opts.json);
    });

  loop
    .command("show")
    .description("Print the session's goal: its state, round and the review's last finding")
    .option("--for <session>", "Target another session (default: the current one)")
    .option("--json", "Machine-readable output")
    .action(async (opts: { for?: string; json?: boolean }) => {
      print(await apiPost(deps, "/cli/goals/show", { session: target(opts) }, { read: true }), opts.json);
    });

  for (const [op, about] of [
    ["pause", "Stop the loop; the goal stays and resume restarts it"],
    ["resume", "Restart a paused or blocked goal with a fresh round budget"],
    ["clear", "Remove the session's goal"],
  ] as const) {
    loop
      .command(op)
      .description(about)
      .option("--for <session>", "Target another session (default: the current one)")
      .option("--json", "Machine-readable output")
      .action(async (opts: { for?: string; json?: boolean }) => {
        const session = target(opts);
        if (op === "resume") {
          const shown = await apiPost(deps, "/cli/goals/show", { session }, { read: true });
          await confirmAtTerminal("resume", shown.goal?.objective ?? "");
        }
        print(await apiPost(deps, "/cli/goals/control", { session, op, from_session: deps.detectCurrentSessionId() ?? undefined }), opts.json);
      });
  }
}
