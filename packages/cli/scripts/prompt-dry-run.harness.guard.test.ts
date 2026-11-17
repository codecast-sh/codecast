// The prompt dry run harness, run as a subprocess with a fake `claude` and a
// fake real `cast` (prompt-dry-run.guard-helpers.ts): prompt-dry-run.ts:
// --model, --call and --max-output-tokens, an agent turn and its --then turns,
// the guard preflight and the run dir lock.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HARNESS, harnessWorld, reply, write } from "./prompt-dry-run.guard-helpers.ts";

// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);

describe("prompt-dry-run.ts: the harness's argv contract and turns", () => {
  test("without --model it exits 2 and never spawns claude", () => {
    const h = harnessWorld([]);
    const r = h.run("--run", h.runDir, "--prompt", h.prompt);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--model is required: an unpinned run takes the account default and cannot be compared");
    expect(h.recorded("argv")).toBeNull();
    expect(fs.existsSync(path.join(h.runDir, "args.json"))).toBe(false);
  }, 30_000);

  test("--call refuses --then, and --system needs --call", () => {
    const h = harnessWorld([]);
    expect(h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--call", "--then", h.prompt).code).toBe(2);
    expect(h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--system", h.system).code).toBe(2);
    expect(h.recorded("argv")).toBeNull();
  }, 30_000);

  test("--call sends the prompt as the whole message with no tools, one turn and the cap in env", () => {
    const h = harnessWorld([...reply("ok", "end_turn", 2), { type: "result", result: "ok", stop_reason: "end_turn", usage: { input_tokens: 190, output_tokens: 2 }, modelUsage: { "m-pinned": {} }, is_error: false, num_turns: 1, total_cost_usd: 0.0002 }]);
    const r = h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m-pinned", "--call", "--system", h.system, "--max-output-tokens", "20", "--account", "fake");
    expect(r.code).toBe(0);
    const argv = h.recorded("argv")!.split("\n");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--system-prompt-file") + 1]).toBe(h.system);
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("1");
    expect(argv[argv.indexOf("--model") + 1]).toBe("m-pinned");
    expect(argv).not.toContain("--allowedTools");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(h.recorded("stdin")).toBe("Reply with the word ok.");
    expect(h.recorded("env")).toBe("20\n1\nfake-token\n");
    expect(JSON.parse(fs.readFileSync(path.join(h.runDir, "args.json"), "utf8"))).toEqual({
      model: "m-pinned", call: true, maxOutputTokens: 20, tools: [], maxTurns: 1, serve: null, guard: path.join(import.meta.dir, "prompt-dry-run-bin"), isolation: null, claudeMd: null, seed: null, cwd: null, readOnly: false, fake: null, fakeSeed: null,
    });
    const out = JSON.parse(fs.readFileSync(path.join(h.runDir, "out.json"), "utf8"));
    expect(out).toMatchObject({ result: "ok", stop_reason: "end_turn", is_error: false });
    expect(out.resumed_past_cap).toBeUndefined();
    expect(fs.existsSync(path.join(h.runDir, ".claude"))).toBe(false);
  }, 30_000);

  test("--call without --system sends one neutral line", () => {
    const h = harnessWorld([...reply("ok", "end_turn", 2), { type: "result", result: "ok", is_error: false }]);
    expect(h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--call", "--account", "fake").code).toBe(0);
    const argv = h.recorded("argv")!.split("\n");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("Follow the user's instructions.");
    expect(h.recorded("env")).toBe("unset\n1\nfake-token\n");
  }, 30_000);

  test("a call cut at max_tokens reports the first reply, not claude's resumed turns", () => {
    const h = harnessWorld([
      ...reply("1\n2\n3", "max_tokens", 20),
      { type: "user", message: { content: [{ type: "text", text: "Output token limit hit. Resume directly" }] } },
      ...reply("4\n5\n6", "max_tokens", 20),
      { type: "result", result: "API Error: Claude's response exceeded the 20 output token maximum.", stop_reason: "stop_sequence", usage: { output_tokens: 40 }, modelUsage: { "m-pinned": { outputTokens: 40 } }, is_error: true, num_turns: 2, total_cost_usd: 0.001 },
    ]);
    const r = h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m-pinned", "--call", "--max-output-tokens", "20", "--account", "fake");
    expect(r.code).toBe(0);
    const out = JSON.parse(fs.readFileSync(path.join(h.runDir, "out.json"), "utf8"));
    expect(out).toMatchObject({ result: "1\n2\n3", stop_reason: "max_tokens", usage: { input_tokens: 190, output_tokens: 20 }, is_error: false, num_turns: 1, resumed_past_cap: 1, total_cost_usd: 0.001, modelUsage: { "m-pinned": { outputTokens: 40 } } });
    expect(fs.readFileSync(path.join(h.runDir, "said.txt"), "utf8")).toBe("1\n2\n3\n");
    expect(fs.readFileSync(path.join(h.runDir, "exit.txt"), "utf8")).toBe("0\n");
  }, 30_000);

  test("an agent turn opens with the briefing itself as the user message, and keeps every message in said.json", () => {
    const h = harnessWorld([
      { type: "assistant", message: { content: [{ type: "text", text: "First.\n\n────────\n\nstill first" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Second." }] } },
      { type: "result", result: "Second.", is_error: false, num_turns: 2, total_cost_usd: 0.01 },
    ]);
    expect(h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    const argv = h.recorded("argv")!.split("\n");
    expect(h.recorded("stdin")).toBe("Reply with the word ok.");
    expect(argv[argv.indexOf("-p") + 1]).toBe("--allowedTools");
    expect(argv.join(" ")).not.toContain(h.prompt);
    expect(JSON.parse(fs.readFileSync(path.join(h.runDir, "said.json"), "utf8"))).toEqual(["First.\n\n────────\n\nstill first", "Second."]);
    // The guard stays first on every Bash command even when the profile puts the real cast ahead of it.
    // The run's own copy of the guard, with its broker baked in (prompt-dry-run.ts bakeGuard).
    expect(h.recorded("path-first")).toBe(path.join(`${h.runDir}.harness`, "guard"));
  }, 30_000);

  test("a cast the agent reaches around the guard, by an absolute path with no guard on PATH, still answers from the guard", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const main = path.join(import.meta.dir, "..", "src", "main.ts");
    const bash = `PATH=/usr/bin:/bin '${process.execPath}' '${main}' task create Something`;
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    expect(h.recorded("bash")).toContain("dry run: 'cast task create Something' would write, and is refused");
    expect(fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8")).toBe("task create Something\nREFUSED task create Something\n");
  }, 60_000);

  // 2026-10-05: agents left running after their harness was killed went around the guard with the
  // real state directory and wrote proposals to prod. Every route they had is tried here.

  test.if(process.platform === "darwin")("a guard that cannot answer stops the run before any agent starts", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false }]);
    const broken = path.join(h.dir, "broken-guard");
    write(path.join(broken, "cast"), "#!/usr/bin/env bash\necho 'cannot create temp file for here document' >&2\nexit 1\n", 0o755);
    const r = h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--guard", broken);
    expect(r.code).toBe(2);
    expect(r.err).toContain("the dry run's guard is not usable, so no agent starts");
    expect(r.err).toContain("cannot create temp file for here document");
    expect(h.recorded("argv")).toBeNull();
  }, 60_000);

  test("a run dir that belongs to a live run is refused, and nothing in it is touched", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false }]);
    write(path.join(h.runDir, "harness.pid"), `${process.pid}\n`);
    write(path.join(h.runDir, ".claude", "dry-run-env.sh"), "live");
    const r = h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake");
    expect(r.code).toBe(2);
    expect(r.err).toContain(`belongs to a run still alive (harness pid ${process.pid})`);
    expect(fs.readFileSync(path.join(h.runDir, ".claude", "dry-run-env.sh"), "utf8")).toBe("live");
    expect(h.recorded("argv")).toBeNull();
  }, 30_000);

  test("--isolation-check answers whether agent scratch is private here, and runs nothing else", () => {
    const r = Bun.spawnSync(["bun", HARNESS, "--isolation-check"], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir() } });
    if (process.platform === "darwin") expect({ code: r.exitCode, out: r.stdout.toString() }).toEqual({ code: 0, out: "isolated\n" });
    else expect(r.exitCode).toBe(3);
  }, 30_000);

  // evals grow scores and tests a model's edit this way: code nobody vouches for, written from prod text.

  test("each --then is one more turn resumed into the same session, in order, with a turn line in calls.log", () => {
    const h = harnessWorld([
      { type: "assistant", message: { content: [{ type: "text", text: "Said." }] } },
      { type: "result", result: "Said.", is_error: false, num_turns: 1, total_cost_usd: 0.01, session_id: "s-1" },
    ]);
    write(path.join(h.dir, "then2.md"), "Second message.");
    write(path.join(h.dir, "then3.md"), "Third message.");
    expect(h.run("--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--then", path.join(h.dir, "then2.md"), "--then", path.join(h.dir, "then3.md")).code).toBe(0);
    for (const n of ["2", "3"]) {
      expect(JSON.parse(fs.readFileSync(path.join(h.runDir, `said${n}.json`), "utf8"))).toEqual(["Said."]);
      expect(fs.existsSync(path.join(h.runDir, `out${n}.json`))).toBe(true);
    }
    const argv = h.recorded("argv")!.split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("s-1");
    expect(argv[argv.indexOf("-p") + 1]).toBe("Third message.");
    expect(fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8")).toBe("# turn 2\n# turn 3\n");
  }, 30_000);
});
