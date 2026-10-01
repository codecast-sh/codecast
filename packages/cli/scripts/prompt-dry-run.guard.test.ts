// The prompt dry run harness and its guard `cast`, run as subprocesses with no
// network, no keychain and no model: a fake real `cast` and a fake `claude`
// stand in for both. Covers the served-read cassette (docs/architecture/evals-home.md 2.6)
// and the harness's --model, --call and --max-output-tokens contract.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { servedReadKey } from "../../evals/src/served.ts";

const GUARD = path.join(import.meta.dir, "prompt-dry-run-bin", "cast");
const HARNESS = path.join(import.meta.dir, "prompt-dry-run.ts");
// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-guard-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function write(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

/** A run dir, a serve dir and a fake real `cast` that answers `LIVE <argv>`. */
function world(serve: { files?: Record<string, string>; frozen?: string[]; usage?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "w-"));
  const runDir = path.join(dir, "run");
  const serveDir = path.join(dir, "serve");
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(serveDir, { recursive: true });
  // `usage` answers `<words> --help` with that Usage line, as the real CLI does.
  const usage = Object.entries(serve.usage ?? {}).map(([words, line]) => `[ "$*" = "${words} --help" ] && { echo "Usage: ${line}"; exit 0; }\n`).join("");
  write(path.join(fakeBin, "cast"), `#!/usr/bin/env bash\n${usage}echo "LIVE $* dir=\${CODECAST_DIR:-}"\n`, 0o755);
  for (const [name, text] of Object.entries(serve.files ?? {})) write(path.join(serveDir, name), text);
  if (serve.frozen) write(path.join(serveDir, "frozen"), serve.frozen.join("\n") + "\n");
  const cast = (...argv: string[]) => {
    const r = Bun.spawnSync(["bash", GUARD, ...argv], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, RUN_DIR: runDir, DRY_RUN_SERVE_DIR: serveDir, DRY_RUN_REAL_CODECAST_DIR: "/real/state", CODECAST_DIR: path.join(runDir, ".nocast") },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const log = () => fs.readFileSync(path.join(runDir, "calls.log"), "utf8");
  return { cast, log, serveDir };
}

describe("guard cast: served reads", () => {
  test("the two key vectors hold, and the guard files reads under the same key", () => {
    expect(servedReadKey(["brief"])).toBe("5aade2e80f5dd74f765b32cf20b9954d5283af5331c34e0ad909d8a609cecbcf");
    expect(servedReadKey(["org", "review", "--team", "T"])).toBe("c3c8e1815ea12c65ef7b12528037651900c290fc2fe246959cf0beb491c3b04a");
    const w = world({
      files: {
        [`reads/${servedReadKey(["brief"])}.out`]: "the brief\n",
        [`reads/${servedReadKey(["org", "review", "--team", "T"])}.out`]: "the review prompt\n",
      },
    });
    expect(w.cast("brief").out).toBe("the brief\n");
    expect(w.cast("org", "review", "--team", "T").out).toBe("the review prompt\n");
  });

  test("the legacy org files are served", () => {
    const w = world({ files: { "org-inputs.json": '{"inputs":1}', "org-health.json": '{"health":1}', "org-ls.json": '{"ls":1}' } });
    expect(w.cast("org", "inputs", "--team", "T", "--json")).toMatchObject({ code: 0, out: '{"inputs":1}' });
    expect(w.cast("org", "health", "--json").out).toBe('{"health":1}');
    expect(w.cast("org", "ls", "--json").out).toBe('{"ls":1}');
    expect(w.cast("org", "proposals").out).toBe("No open proposals.\n");
    expect(w.log()).toContain("SERVED org inputs --team T --json");
  });

  test("a captured read is served with its exit code", () => {
    const argv = ["sessions", "--json"];
    const w = world({ files: { [`reads/${servedReadKey(argv)}.out`]: "[]\n", [`reads/${servedReadKey(argv)}.exit`]: "3\n" } });
    expect(w.cast(...argv)).toMatchObject({ code: 3, out: "[]\n" });
    expect(w.log()).toContain("SERVED sessions --json");
  });

  test("a frozen read that was not captured is refused and logged UNSERVED", () => {
    const w = world({ frozen: ["brief", "trigger show"] });
    const r = w.cast("brief", "--since", "1d");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("dry run: 'cast brief --since 1d' is frozen for this replay and was not captured");
    expect(w.log()).toContain("UNSERVED brief --since 1d");
    expect(w.cast("trigger", "show", "tr-1").code).toBe(1);
    expect(w.log()).toContain("UNSERVED trigger show tr-1");
    // Only the frozen pair: a sibling read under the same first word stays live.
    expect(w.cast("trigger", "ls").out).toBe("LIVE trigger ls dir=/real/state\n");
  });

  test("a read nothing froze goes to the real cast with the real state dir", () => {
    const w = world({ frozen: ["brief"] });
    const r = w.cast("read", "jx7abcd", "1:5");
    expect(r).toMatchObject({ code: 0, out: "LIVE read jx7abcd 1:5 dir=/real/state\n" });
    expect(w.log()).toContain("LIVE read jx7abcd 1:5");
  });

  test("org review is a read without --spawn and refused with it", () => {
    const w = world();
    expect(w.cast("org", "review", "--team", "T").out).toBe("LIVE org review --team T dir=/real/state\n");
    const r = w.cast("org", "review", "--team", "T", "--spawn");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(w.log()).toContain("REFUSED org review --team T --spawn");
  });

  test("decide show and ls are reads; any other decide posts and is refused", () => {
    const w = world();
    expect(w.cast("decide", "show", "sd-5").out).toBe("LIVE decide show sd-5 dir=/real/state\n");
    expect(w.cast("decide", "ls").out).toBe("LIVE decide ls dir=/real/state\n");
    for (const argv of [["decide", "Ship it?"], ["decide", "Ship it?", "-o", "Yes"], ["decide", "recommend", "sd-5", "1"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).toContain(`REFUSED ${argv.join(" ")}`);
    }
  });

  test("pr, chat and trigger history reads go live; their writes are refused", () => {
    const w = world();
    for (const argv of [["pr", "ls"], ["pr", "show", "12"], ["pr", "events", "12"], ["pr", "threads", "12"], ["chat", "read", "--channel", "c1"], ["chat", "thread", "m1"], ["chat", "channels"], ["trigger", "log", "tr-1"], ["trigger", "history", "tr-1"]]) {
      expect(w.cast(...argv).out).toBe(`LIVE ${argv.join(" ")} dir=/real/state\n`);
    }
    for (const argv of [["pr", "comment", "12", "hi"], ["pr", "merge", "12"], ["pr", "review", "12", "--approve"], ["chat", "send", "hi"], ["chat", "mark-read"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).toContain(`REFUSED ${argv.join(" ")}`);
    }
  });

  test("a word a pure command group has no subcommand for answers as the CLI does and is logged UNKNOWN, never REFUSED", () => {
    const w = world({ usage: { "org roles": "cast org [options] [command]", "send jx7abc": "cast send [options] <session_id> <text>", "decide yes": "cast decide [options] [question] [args...]" } });
    const helpDir = path.join(path.dirname(w.serveDir), "run", ".cast-help");
    expect(w.cast("org", "roles", "--team", "T").out).toBe(`LIVE org roles dir=${helpDir}\n`);
    expect(w.log()).toContain("UNKNOWN org roles --team T");
    // A leaf with arguments of its own, or a group that takes them, is a write: still refused.
    for (const argv of [["send", "jx7abc", "hi"], ["decide", "yes"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).toContain(`REFUSED ${argv.join(" ")}`);
    }
    expect(w.log()).not.toContain("UNKNOWN send");
  });

  test("--help prints the CLI's own text under a state dir of its own, never frozen or refused", () => {
    const w = world({ frozen: ["*"] });
    const helpDir = path.join(path.dirname(w.serveDir), "run", ".cast-help");
    expect(w.cast("org", "--help")).toMatchObject({ code: 0, out: `LIVE org --help dir=${helpDir}\n` });
    expect(w.cast("task", "create", "--help").out).toBe(`LIVE task create --help dir=${helpDir}\n`);
    expect(w.cast("--help").out).toBe(`LIVE --help dir=${helpDir}\n`);
    expect(w.log()).toContain("HELP org --help");
    expect(w.log()).not.toContain("REFUSED");
    expect(w.log()).not.toContain("UNSERVED");
  });

  test("a --help commander would read as an option's value reaches only help, never the action or the real state", () => {
    const w = world();
    const helpDir = path.join(path.dirname(w.serveDir), "run", ".cast-help");
    // `-d --help`: commander takes --help as the description and would run create.
    expect(w.cast("task", "create", "X", "-d", "--help").out).toBe(`LIVE task create --help dir=${helpDir}\n`);
    // `--thread --help "text"`: commander takes --help as the thread and would post.
    expect(w.cast("chat", "send", "--channel", "C", "--thread", "--help", "text").out).toBe(`LIVE chat send --help dir=${helpDir}\n`);
    expect(w.cast("decide", "Ship it?", "--help").out).toBe(`LIVE decide --help dir=${helpDir}\n`);
    expect(w.log()).not.toContain("/real/state");
  });

  test("a --help after -- is an operand, not help: the write is refused", () => {
    const w = world();
    const r = w.cast("send", "jx7abcd", "--", "--help");
    expect(r).toMatchObject({ code: 1, out: "" });
    expect(w.log()).toContain("REFUSED send jx7abcd -- --help");
    expect(w.log()).not.toContain("HELP");
  });

  test("a * line freezes every read, so a world answers from its record or not at all", () => {
    const w = world({ frozen: ["*"], files: { [`reads/${servedReadKey(["brief"])}.out`]: "the brief\n" } });
    expect(w.cast("brief").out).toBe("the brief\n");
    for (const argv of [["plan", "show", "pl-31"], ["trigger", "ls"], ["read", "jx7abcd"], ["feed"]]) {
      expect(w.cast(...argv)).toMatchObject({ code: 1, out: "" });
      expect(w.log()).toContain(`UNSERVED ${argv.join(" ")}`);
    }
    expect(w.log()).not.toContain("LIVE");
    // Writes stay writes.
    w.cast("task", "create", "X");
    expect(w.log()).toContain("REFUSED task create X");
  });

  test("writes are refused and logged REFUSED, frozen or not", () => {
    const w = world({ frozen: ["org", "task"] });
    const r = w.cast("task", "create", "Something");
    expect(r.code).toBe(1);
    expect(r.err).toContain("would write, and is refused");
    expect(w.log()).toContain("REFUSED task create Something");
    // A write under a frozen verb is a write, not an uncaptured read.
    w.cast("org", "propose", "--spec", "x.json");
    expect(w.log()).toContain("REFUSED org propose --spec x.json");
    expect(w.log()).not.toContain("UNSERVED org propose");
    w.cast("send", "jx7abcd", "hi");
    w.cast("state", "--status", "done", "x");
    expect(w.log()).toContain("REFUSED send jx7abcd hi");
    expect(w.log()).toContain("REFUSED state --status done x");
  });
});

/** A fake `claude` that records how it was called and prints a canned stream. */
function harnessWorld(stream: object[]) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "h-"));
  const bin = path.join(dir, "bin");
  const rec = path.join(dir, "rec");
  const state = path.join(dir, "state");
  fs.mkdirSync(rec, { recursive: true });
  write(path.join(bin, "claude"), [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$@" > "$FAKE_CLAUDE_REC/argv"',
    'cat > "$FAKE_CLAUDE_REC/stdin"',
    'printf "%s\\n" "${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-unset}" "${CLAUDE_CODE_DISABLE_THINKING:-unset}" "${CLAUDE_CODE_OAUTH_TOKEN:-unset}" > "$FAKE_CLAUDE_REC/env"',
    'cat "$FAKE_CLAUDE_STREAM"',
    "",
  ].join("\n"), 0o755);
  write(path.join(dir, "stream.jsonl"), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // `--account fake` reads its token from the state dir, so no keychain is touched.
  write(path.join(state, "cc-token-fake.env"), "CLAUDE_CODE_OAUTH_TOKEN='fake-token'\n");
  write(path.join(dir, "prompt.md"), "Reply with the word ok.");
  write(path.join(dir, "system.md"), "Answer briefly.");
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", HARNESS, ...args], {
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, CODECAST_DIR: state, FAKE_CLAUDE_REC: rec, FAKE_CLAUDE_STREAM: path.join(dir, "stream.jsonl") },
    });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  const recorded = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : null);
  return { dir, run, recorded, runDir: path.join(dir, "run"), prompt: path.join(dir, "prompt.md"), system: path.join(dir, "system.md") };
}

const reply = (text: string, stop: string, outputTokens: number) => [
  { type: "stream_event", event: { type: "message_start", message: { model: "m-pinned", usage: { input_tokens: 190, output_tokens: 1 } } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outputTokens } } },
  { type: "assistant", message: { content: [{ type: "text", text }] } },
];

describe("prompt-dry-run.ts", () => {
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
      model: "m-pinned", call: true, maxOutputTokens: 20, tools: [], maxTurns: 1, serve: null, guard: path.join(import.meta.dir, "prompt-dry-run-bin"),
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
});
