// ct-101911: a Task-tool subagent's Bash runs in its parent's Claude process with
// the parent's session id, so a run or task start it makes must not adopt the
// parent. Only the transcripts tell the two apart.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commandRuns, subagentCalling } from "./subagentCaller";

const SESSION = "b79f5fd7-6971-4271-b942-2e30a02e438b";
const ARGS = ["flow", "run", "change", "--task", "ct-7"];
let projects: string;
let dir: string;

function bash(command: string, at: string, agentId?: string): string {
  return JSON.stringify({
    ...(agentId ? { isSidechain: true, agentId } : { isSidechain: false }),
    timestamp: at,
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] },
  });
}
function write(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
const mainFile = () => path.join(dir, `${SESSION}.jsonl`);
const subFile = (id: string) => path.join(dir, SESSION, "subagents", `agent-${id}.jsonl`);
const ask = () => subagentCalling(SESSION, ARGS, { projectsDirs: [projects], startedAt: Date.now() });

beforeEach(() => {
  projects = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-caller-"));
  dir = path.join(projects, "-Users-someone-code-repo");
});
afterEach(() => fs.rmSync(projects, { recursive: true, force: true }));

describe("subagentCalling", () => {
  test("a subagent's Bash call names that subagent, not its parent", () => {
    write(mainFile(), [bash("git status", "2026-11-26T10:00:00Z")]);
    write(subFile("a1"), [bash("cd /repo && cast flow run change --task ct-7 2>&1 | tail -5", "2026-11-26T10:00:05Z", "a1")]);
    expect(ask()).toBe("a1");
  });

  test("the session's own agent is the caller when its call is the newest, even with a subagent live", () => {
    write(subFile("a1"), [bash("cast flow run change --task ct-7", "2026-11-26T10:00:00Z", "a1")]);
    write(mainFile(), [bash("cast flow run change --task ct-7", "2026-11-26T10:00:09Z")]);
    expect(ask()).toBeNull();
  });

  test("a session that never ran a subagent is its own caller, read without opening its transcript", () => {
    write(mainFile(), []);
    expect(ask()).toBeNull();
  });

  test("a subagent transcript untouched since well before the command started is not the caller", () => {
    write(mainFile(), [bash("cast flow run change --task ct-7", "2026-11-26T09:00:00Z")]);
    write(subFile("a1"), [bash("cast flow run change --task ct-7", "2026-11-26T10:00:00Z", "a1")]);
    const old = (Date.now() - 600_000) / 1000;
    fs.utimesSync(subFile("a1"), old, old);
    expect(ask()).toBeNull();
  });

  test("no transcript naming the call (a script that runs cast) is no evidence of a subagent", () => {
    write(mainFile(), []);
    write(subFile("a1"), [bash("./ship.sh", "2026-11-26T10:00:00Z", "a1")]);
    expect(ask()).toBeNull();
  });

  test("an unknown session is nobody's subagent", () => {
    expect(ask()).toBeNull();
  });
});

describe("commandRuns", () => {
  test("each plain argument appears as a word, in order", () => {
    expect(commandRuns("cd /x && cast flow run change --task ct-7 --json", ARGS)).toBe(true);
    expect(commandRuns("cast flow run change --task ct-77", ARGS)).toBe(false);
    expect(commandRuns("cast flow runs change --task ct-7", ARGS)).toBe(false);
    expect(commandRuns("cast flow change run --task ct-7", ARGS)).toBe(false);
  });

  test("arguments a shell quotes are skipped, since their spelling varies", () => {
    expect(commandRuns(`cast task create "Fix the thing" -p high`, ["task", "create", "Fix the thing", "-p", "high"])).toBe(true);
    expect(commandRuns("cast", [])).toBe(false);
  });
});
