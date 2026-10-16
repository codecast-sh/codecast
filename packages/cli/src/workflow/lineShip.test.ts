// The shipped line's ship station and its dead ends (ct-58732, ct-56374): a
// refusal reaches the task in the ship command's own words, a branch the
// default branch moved past goes back to rebase, and a node with no route
// names the fields it routes on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { evalCondition } from "./condition";
import { parseWorkflowSource } from "./parser";
import { expandScriptVars } from "./runner";
import { deadEndReason } from "./runFailure";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { lineCommandEnv } from "../lineProfile";

const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
const fired = (id: string, context: Record<string, string>) =>
  graph.edges.filter((e) => e.from === id && e.condition && evalCondition(e.condition, context)).map((e) => e.to);

describe("line ship station", () => {
  let tmp: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "line-ship-"));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    log = path.join(tmp, "cast.log");
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash\nif [ "$1 $2" = "ws path" ]; then echo "${tmp}"; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\necho --- >> "${log}"\n`, { mode: 0o755 });
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const ship = (cmd: string) => {
    const ctx = { worktree: "line-ct-1", task_id: "ct-1", default_branch: "main", run_dir: path.join(tmp, "run"), "line.commands.ship": cmd };
    return spawnSync("bash", ["-c", expandScriptVars(graph.nodes.get("ship")!.script!, ctx)], { cwd: tmp, env: { ...env, ...lineCommandEnv(ctx) }, encoding: "utf-8" }).status;
  };
  const calls = () => fs.readFileSync(log, "utf-8").split("---\n").filter(Boolean).map((c) => c.trimEnd().split("\n"));

  test("a ship command that refuses on stderr alone puts its own words on the task; exit 3 rebases again", () => {
    const behind = 'echo "line: codecast/line-ct-1 is behind origin/main; rebase it first" >&2';
    expect(ship(`${behind}; exit 1`)).toBe(1);
    expect(ship(`${behind}; exit 3`)).toBe(3);
    expect(calls()).toEqual([
      ["task", "comment", "ct-1", "Not shipped: line: codecast/line-ct-1 is behind origin/main; rebase it first", "-t", "blocker"],
      ["task", "comment", "ct-1", "Rebasing again: line: codecast/line-ct-1 is behind origin/main; rebase it first", "-t", "progress"],
    ]);
  });

  test("a branch the default branch moved past since the rebase goes back to rebase, three rebases at most", () => {
    expect(fired("ship", { outcome: "failure", "ship.exit_code": "3" })).toEqual(["rebase"]);
    expect(fired("ship", { outcome: "failure", "ship.exit_code": "1" })).toEqual(["exit"]);
    expect(graph.nodes.get("rebase")?.max_visits).toBe(3);
  });
});

test("a dead end names the fields its node routes on, not a review verdict it never reads", () => {
  const ctx = { handoff: "none", review_verdict: "none" };
  expect(deadEndReason(graph, "implement", "success", ctx)).toBe("no outgoing edge from implement (outcome success, handoff none)");
  expect(deadEndReason(graph, "review", "failure", ctx)).toBe("no outgoing edge from review (outcome failure, review_verdict none)");
  expect(deadEndReason(graph, "watch", "success", ctx)).toBe("no outgoing edge from watch (outcome success)");
});
