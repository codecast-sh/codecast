// `cast flow runs <flow> --at <stations>`: every running run of a flow at those stations, the list a line's own
// queue reads. Acme's onefix Queue read `cast workflow runs`, which pages at 200 newest first, and the runs that
// had waited longest were never let in (Nov 20, 2026).
import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerFlowCommands, type FlowDeps } from "./flowCommand.js";
import { registerFlowRunsCommand, type ConvexQuery } from "./flowRunsCommand.js";

const realExit = process.exit;
const realLog = console.log;
const realError = console.error;
afterEach(() => {
  process.exit = realExit;
  console.log = realLog;
  console.error = realError;
});

const team = async () => ({ kind: "team", teamId: "team_acme" } as const);

async function run(argv: string[], query: ConvexQuery, readWorkspace: FlowDeps["readWorkspace"] = team): Promise<{ out: string[]; err: string[]; code: number | null }> {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | null = null;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  process.exit = ((c?: number) => { code = c ?? 0; throw new Error(`exit ${code}`); }) as typeof process.exit;
  const program = new Command().exitOverride();
  registerFlowRunsCommand(program.command("flow"), { readWorkspace }, query);
  try {
    await program.parseAsync(["node", "cast", ...argv]);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("exit ")) throw e;
  }
  return { out, err, code };
}

describe("cast flow runs", () => {
  test("is a subcommand of cast flow", () => {
    const program = new Command();
    registerFlowCommands(program, {} as FlowDeps);
    const flow = program.commands.find((c) => c.name() === "flow")!;
    expect(flow.commands.map((c) => c.name())).toContain("runs");
  });

  test("asks for the named flow's runs at the named stations and prints the answer whole", async () => {
    const asked: Array<[string, Record<string, unknown>]> = [];
    const answer = { runs: [{ _id: "r1", task_id: "t1", task_short_id: "ct-1", current_node_id: "queue", runner_device: "line-1", created_at: 1, updated_at: 2, results: { harm: "{\"harm\":2}" } }], truncated: false };
    const { out, code } = await run(["flow", "runs", "onefix", "--team", "Acme", "--at", "queue, build", "--results", "harm", "--tasks", "--json"], async (fn, args) => { asked.push([fn, args]); return answer; });
    expect(code).toBeNull();
    expect(asked).toEqual([["workflow_runs.listRunsAtStations", { team_id: "team_acme", workflow_name: "onefix", stations: ["queue", "build"], results: ["harm"], tasks: true }]]);
    expect(JSON.parse(out.join("\n"))).toEqual(answer);
  });

  test("a server without the query fails the read, so a caller can fall back", async () => {
    const { err, code } = await run(["flow", "runs", "onefix", "--at", "queue", "--json"], async () => { throw new Error("Could not find public function for 'workflow_runs:listRunsAtStations'"); });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Could not find public function");
  });

  test("a personal workspace has no line to read", async () => {
    const { code } = await run(["flow", "runs", "onefix", "--at", "queue"], async () => { throw new Error("not asked"); }, async () => ({ kind: "personal" }));
    expect(code).toBe(1);
  });
});
