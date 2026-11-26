// ct-101911: a Task-tool subagent's Bash runs in its parent's Claude process with
// the parent's session id, so a run or task start it makes must not adopt the
// parent. Only the transcripts tell the two apart.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commandRuns, subagentCalling } from "./subagentCaller";

const SESSION = "00000000-0000-4000-8000-000000000001";
const ARGS = ["flow", "run", "change", "--task", "ct-7"];
const RUN = "cast flow run change --task ct-7";
let projects: string;
let dir: string;
let startedAt: number;

/** A transcript line: a Bash call `ms` from this process's start, made by `agent` (a Task tool's, flagged as a
 *  sidechain) or `{ workflow }` (a Workflow tool's, which carries only its agentId), else the session's own agent. */
function bash(command: string, ms: number, agent?: string | { workflow: string }, type = "assistant"): string {
  const who = typeof agent === "string" ? { isSidechain: true, agentId: agent } : agent ? { agentId: agent.workflow } : { isSidechain: false };
  return JSON.stringify({
    type,
    ...who,
    timestamp: new Date(startedAt + ms).toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] },
  });
}
function write(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
const mainFile = () => path.join(dir, `${SESSION}.jsonl`);
const subFile = (id: string) => path.join(dir, SESSION, "subagents", `agent-${id}.jsonl`);
const workflowFile = (id: string) => path.join(dir, SESSION, "subagents", "workflows", "wf_0001", `agent-${id}.jsonl`);
const ask = () => subagentCalling(SESSION, ARGS, { projectsDirs: [projects], startedAt });

beforeEach(() => {
  projects = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-caller-"));
  dir = path.join(projects, "-home-someone-code-repo");
  startedAt = Date.now();
});
afterEach(() => fs.rmSync(projects, { recursive: true, force: true }));

describe("subagentCalling", () => {
  test("a subagent's Bash call names that subagent, not its parent", () => {
    write(mainFile(), [bash("git status", -5_000)]);
    write(subFile("a1"), [bash(`cd /repo && ${RUN} 2>&1 | tail -5`, -500, "a1")]);
    expect(ask()).toBe("a1");
  });

  test("a Workflow tool's agent, which carries its agentId and no sidechain flag, is a subagent too", () => {
    write(mainFile(), []);
    write(workflowFile("w1"), [bash(RUN, -500, { workflow: "w1" })]);
    expect(ask()).toBe("w1");
  });

  test("the session's own agent is the caller when its call is the newest, even with a subagent live", () => {
    write(subFile("a1"), [bash(RUN, -8_000, "a1")]);
    write(mainFile(), [bash(RUN, -400)]);
    expect(ask()).toBeNull();
  });

  test("a subagent's old matching call is not the caller when the session's own call does not spell the command out", () => {
    // The parent runs it through a loop; the subagent ran the same words a minute ago and has written since.
    write(mainFile(), [bash('for t in ct-7; do cast flow run change --task "$t"; done', -300)]);
    write(subFile("a1"), [bash(RUN, -60_000, "a1"), bash("git status", -1_000, "a1")]);
    expect(ask()).toBeNull();
  });

  test("a call written after this process started ran some other process", () => {
    write(mainFile(), [bash(RUN, -400)]);
    write(subFile("a1"), [bash(`${RUN} --json`, 5_000, "a1")]);
    expect(ask()).toBeNull();
  });

  test("only an assistant's tool call counts, not a line that quotes one", () => {
    write(mainFile(), []);
    write(subFile("a1"), [bash(RUN, -500, "a1", "user")]);
    expect(ask()).toBeNull();
  });

  test("a session that never ran a subagent is its own caller", () => {
    write(mainFile(), []);
    expect(ask()).toBeNull();
  });

  test("a subagent transcript untouched since well before the command started is not the caller", () => {
    write(mainFile(), []);
    write(subFile("a1"), [bash(RUN, -500, "a1")]);
    const old = (startedAt - 600_000) / 1000;
    fs.utimesSync(subFile("a1"), old, old);
    expect(ask()).toBeNull();
  });

  test("no transcript naming the call (a script that runs cast) is no evidence of a subagent", () => {
    write(mainFile(), []);
    write(subFile("a1"), [bash("./ship.sh", -500, "a1")]);
    expect(ask()).toBeNull();
  });

  test("an unknown session is nobody's subagent", () => {
    expect(ask()).toBeNull();
  });
});

describe("commandRuns", () => {
  test("each plain argument appears as a word, in order", () => {
    expect(commandRuns(`cd /x && ${RUN} --json`, ARGS)).toBe(true);
    expect(commandRuns("cast flow run change --task ct-77", ARGS)).toBe(false);
    expect(commandRuns("cast flow runs change --task ct-7", ARGS)).toBe(false);
    expect(commandRuns("cast flow change run --task ct-7", ARGS)).toBe(false);
  });

  test("arguments a shell quotes are skipped, since their spelling varies", () => {
    expect(commandRuns(`cast task create "Fix the thing" -p high`, ["task", "create", "Fix the thing", "-p", "high"])).toBe(true);
    expect(commandRuns("cast", [])).toBe(false);
  });
});
