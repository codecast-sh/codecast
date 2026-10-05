// The prompt dry run harness and its guard `cast`, run as subprocesses with no
// network, no keychain and no model: a fake real `cast` and a fake `claude`
// stand in for both. Covers the served-read cassette (docs/architecture/evals-home.md 2.6)
// and the harness's --model, --call and --max-output-tokens contract.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loggedArgv, servedReadKey } from "../../evals/src/served.ts";

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

/** A stand-in for `cast agent-context --json`: each entry is a path, whether it
 *  runs something bare, and its aliases. Subcommands are derived from the paths. */
type TreeEntry = [path: string, runsBare: boolean | undefined, aliases?: string[]];
function agentContext(entries: TreeEntry[]) {
  const commands = entries.map(([command, runsBare, aliases]) => ({
    command,
    path: command.split(" "),
    aliases: aliases ?? [],
    subcommands: entries.map(([c]) => c).filter((c) => c.startsWith(`${command} `) && c.split(" ").length === command.split(" ").length + 1),
    ...(runsBare === undefined ? {} : { runsBare }),
  }));
  return JSON.stringify({ schemaVersion: 1, version: "9.9.9", commandCount: commands.length, commands });
}

/** A tree shaped like the CLI's: pure groups, groups that run something bare
 *  (sync's own action, hosts's default ls), leaves, and an alias. */
const TREE: TreeEntry[] = [
  ["org", false], ["org ls", true], ["org review", true], ["org propose", true],
  ["task", false], ["task ls", true], ["task create", true],
  ["workspace", false, ["ws"]], ["workspace ls", true],
  ["pr", false], ["pr comment", true], ["pr merge", true], ["pr review", true],
  ["chat", false], ["chat send", true], ["chat mark-read", true],
  ["sync", true], ["sync status", true],
  ["hosts", true], ["hosts ls", true],
  ["send", true], ["decide", true], ["state", true],
  ["brief", true], ["brief edit", true], ["call", true],
];

/** A run dir, a serve dir and a fake real `cast` that answers `LIVE <argv>`,
 *  answers `agent-context --json` from `tree`, and records every argv it gets. */
function world(serve: { files?: Record<string, string>; frozen?: string[]; tree?: TreeEntry[] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "w-"));
  const runDir = path.join(dir, "run");
  const serveDir = path.join(dir, "serve");
  const fakeBin = path.join(dir, "bin");
  const realCalls = path.join(dir, "real-calls");
  const tree = path.join(dir, "agent-context.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(serveDir, { recursive: true });
  write(tree, agentContext(serve.tree ?? TREE));
  write(path.join(fakeBin, "cast"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${realCalls}"`,
    `[ "$*" = "agent-context --json" ] && { cat "${tree}"; exit 0; }`,
    'echo "LIVE $* dir=${CODECAST_DIR:-}"',
    "",
  ].join("\n"), 0o755);
  for (const [name, text] of Object.entries(serve.files ?? {})) write(path.join(serveDir, name), text);
  if (serve.frozen) write(path.join(serveDir, "frozen"), serve.frozen.join("\n") + "\n");
  const cast = (...argv: string[]) => {
    const r = Bun.spawnSync(["bash", GUARD, ...argv], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, RUN_DIR: runDir, DRY_RUN_SERVE_DIR: serveDir, DRY_RUN_REAL_CODECAST_DIR: "/real/state", CODECAST_DIR: path.join(runDir, ".nocast") },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const log = () => fs.readFileSync(path.join(runDir, "calls.log"), "utf8");
  /** Every argv the real CLI was run with. */
  const real = () => (fs.existsSync(realCalls) ? fs.readFileSync(realCalls, "utf8").split("\n").filter(Boolean) : []);
  return { cast, log, real, runDir, serveDir, helpDir: path.join(runDir, ".cast-help") };
}

/** An argv as calls.log keeps it: an argument that is not a plain word single-quoted. */
const logged = (argv: string[]) => argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

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
    // What the live workspace answered is kept under the served-read key, so the run shows what it saw.
    const kept = path.join(w.runDir, "live-reads", servedReadKey(["read", "jx7abcd", "1:5"]));
    expect(fs.readFileSync(`${kept}.out`, "utf8")).toBe(r.out);
    expect(fs.readFileSync(`${kept}.exit`, "utf8")).toBe("0\n");
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
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
  });

  test("stack show and ls are reads; any other stack verb writes and never reaches the real CLI", () => {
    const w = world();
    expect(w.cast("stack", "show", "ds-5").out).toBe("LIVE stack show ds-5 dir=/real/state\n");
    expect(w.cast("stack", "ls").out).toBe("LIVE stack ls dir=/real/state\n");
    for (const argv of [["stack", "create", "Billing"], ["stack", "add", "ds-5", "sd-9"], ["stack", "policy", "ds-5", "--due", "tomorrow"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).not.toContain(`LIVE ${argv.join(" ")}`);
    }
  });

  test("goals, plan replay and a published page's reads go live; publish writes are refused", () => {
    const w = world();
    for (const argv of [["goals", "--brief"], ["plan", "replay", "pl-4"], ["publish", "ls", "--json"], ["publish", "comments", "pg"]]) {
      expect(w.cast(...argv).out).toBe(`LIVE ${argv.join(" ")} dir=/real/state\n`);
    }
    for (const argv of [["publish", "report.html"], ["publish", "comments", "pg", "--resolve", "c1"], ["publish", "comments", "pg", "--resolve=c1"], ["publish", "comments", "pg", "--resolve-all"], ["publish", "rm", "pg"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).not.toContain(`LIVE ${argv.join(" ")}`);
    }
  });

  test("a session read goes live; read --ack (marks it read) and --ask (a paid model call) are refused unless the world served them", () => {
    const w = world({ tree: [...TREE, ["read", true]] });
    expect(w.cast("read", "jx7abcd", "--full").out).toBe("LIVE read jx7abcd --full dir=/real/state\n");
    for (const argv of [["read", "jx7abcd", "--ack"], ["read", "jx7abcd", "--ack=true"], ["read", "jx7abcd", "--ask", "what landed?"], ["read", "jx7abcd", "--ask=what landed?"]]) {
      const r = w.cast(...argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain("read the session without them");
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
    expect(w.real().filter((a) => a !== "agent-context --json")).toEqual(["read jx7abcd --full"]);
    // A synthetic world's prefix record still answers --ask with the transcript it holds.
    const prefixed = ["read", "jx7abcd"];
    const k = servedReadKey(prefixed);
    const served = world({ files: { [`reads/${k}.out`]: "the transcript\n", [`reads/${k}.prefix`]: prefixed.map((a) => `${a}\x1f`).join("") } });
    expect(served.cast("read", "jx7abcd", "--ask", "what landed?")).toMatchObject({ code: 0, out: "the transcript\n" });
    expect(served.real()).toEqual([]);
  });

  test("calls.log keeps every argument's boundaries, so a logged line splits back into the argv and classifies the same", () => {
    const w = world();
    const argv = ["decide", "show which plan ships", "-o", "it's", "", 'a"b'];
    w.cast(...argv);
    expect(w.log()).toContain(`REFUSED decide 'show which plan ships' -o 'it'\\''s' '' 'a"b'\n`);
    const line = w.log().split("\n").find((l) => l.startsWith("REFUSED "))!.slice("REFUSED ".length);
    expect(loggedArgv(line)).toEqual(argv);
    expect(line).toBe(logged(argv));
    const classify = (...a: string[]) => Bun.spawnSync(["bash", GUARD, ...a], { env: { PATH: "/usr/bin:/bin", DRY_RUN_CLASSIFY: "1" } }).stdout.toString().trim();
    // Split back, it is still the write it was; the space-joined line the guard used to log read its question as `decide show`.
    expect(classify(...loggedArgv(line)!)).toBe("write");
    expect(classify(...argv.join(" ").split(" ").filter(Boolean))).toBe("read");
  });

  test("DRY_RUN_CLASSIFY answers read or write and logs and runs nothing", () => {
    const w = world();
    const classify = (...argv: string[]) => {
      const r = Bun.spawnSync(["bash", GUARD, ...argv], { env: { PATH: "/usr/bin:/bin", RUN_DIR: w.runDir, DRY_RUN_CLASSIFY: "1", DRY_RUN_SERVE_DIR: w.serveDir } });
      return r.stdout.toString().trim();
    };
    expect(classify("goals", "--brief")).toBe("read");
    expect(classify("org", "inputs", "--team", "T")).toBe("read");
    expect(classify("brief", "edit", "-")).toBe("write");
    expect(classify("task", "create", "x")).toBe("write");
    expect(classify("plan", "replay", "pl-4")).toBe("read");
    for (const group of ["task", "trigger", "doc", "org"]) expect(classify(group, "replay", "x")).toBe("write");
    expect(classify("publish", "comments", "pg", "--resolve=c1")).toBe("write");
    expect(classify("read", "jx7abcd")).toBe("read");
    expect(classify("read", "jx7abcd", "--ack")).toBe("write");
    expect(classify("read", "jx7abcd", "--ask", "x")).toBe("write");
    expect(fs.existsSync(path.join(w.runDir, "calls.log"))).toBe(false);
    expect(w.real()).toEqual([]);
  });

  test("brief and call reads go live; brief edit, call hold and call snap write and are refused", () => {
    const w = world();
    for (const argv of [["brief"], ["brief", "@chief-of-staff", "--json"], ["call", "cl-42"], ["call", "cl-42", "15:25", "--transcript"]]) {
      expect(w.cast(...argv).out).toBe(`LIVE ${argv.join(" ")} dir=/real/state\n`);
    }
    const writes = [
      ["brief", "edit", "-"], ["brief", "--team", "Codecast", "edit", "-"], ["brief", "edit", "--for", "@chief-of-staff", "-"],
      ["call", "hold", "3m"], ["call", "--for", "jx7abcd", "hold", "off"], ["call", "snap", "cl-42:15"],
    ];
    for (const argv of writes) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
    expect(w.real().filter((a) => a !== "agent-context --json")).toHaveLength(4);
    // Every check here is a guard spawn, about two seconds each at a load of 500.
  }, 120_000);

  test("pr, chat and trigger history reads go live; their writes are refused", () => {
    const w = world();
    for (const argv of [["pr", "ls"], ["pr", "show", "12"], ["pr", "events", "12"], ["pr", "threads", "12"], ["chat", "read", "--channel", "c1"], ["chat", "thread", "m1"], ["chat", "channels"], ["trigger", "log", "tr-1"], ["trigger", "history", "tr-1"]]) {
      expect(w.cast(...argv).out).toBe(`LIVE ${argv.join(" ")} dir=/real/state\n`);
    }
    for (const argv of [["pr", "comment", "12", "hi"], ["pr", "merge", "12"], ["pr", "review", "12", "--approve"], ["chat", "send", "hi"], ["chat", "mark-read"]]) {
      expect(w.cast(...argv).code).toBe(1);
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
  }, 120_000);

  test("a word a pure command group has no subcommand for is answered as commander does, logged UNKNOWN, and run nowhere", () => {
    const w = world();
    const r = w.cast("org", "roles", "--team", "T");
    expect(r).toMatchObject({ code: 1, out: "", err: "error: unknown command 'roles'\nRun 'cast org --help' for the list of commands.\n" });
    expect(w.log()).toContain("UNKNOWN org roles --team T");
    // An alias resolves to its group: `ws frob` is unknown under workspace.
    expect(w.cast("ws", "frob").err).toContain("error: unknown command 'frob'\nRun 'cast workspace --help'");
    expect(w.log()).toContain("UNKNOWN ws frob");
    // The real CLI was asked for its tree, once, and never ran these words.
    expect(w.real()).toEqual(["agent-context --json"]);
  });

  test("a word the CLI has no command for at all is UNKNOWN too: the root runs nothing for it", () => {
    const w = world();
    expect(w.cast("ct", "show", "ct-1")).toMatchObject({ code: 1, out: "", err: "error: unknown command 'ct'\nRun 'cast --help' for the list of commands.\n" });
    expect(w.log()).toContain("UNKNOWN ct show ct-1");
    w.cast("pl");
    expect(w.log()).toContain("UNKNOWN pl\n");
    expect(w.real()).toEqual(["agent-context --json"]);
  });

  test("a group that runs something bare takes the word: cast sync <word> would upload, so it is REFUSED", () => {
    const w = world();
    for (const argv of [["sync", "foo"], ["hosts", "foo"], ["send", "jx7abc", "hi"], ["decide", "yes"], ["task", "create", "X"]]) {
      expect(w.cast(...argv)).toMatchObject({ code: 1, out: "" });
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
    expect(w.log()).not.toContain("UNKNOWN");
    // Nothing but the tree read reached the real CLI.
    expect(w.real()).toEqual(["agent-context --json"]);
  });

  test("a tree without runsBare, from an older CLI, finds nothing unknown: the call is refused", () => {
    const w = world({ tree: TREE.map(([c, , aliases]): TreeEntry => [c, undefined, aliases]) });
    w.cast("org", "roles");
    w.cast("ct", "show");
    expect(w.log()).toContain("REFUSED org roles");
    expect(w.log()).toContain("REFUSED ct show");
    expect(w.log()).not.toContain("UNKNOWN");
  });

  test("a pure group's help word is commander's help command", () => {
    const w = world();
    expect(w.cast("org", "help").out).toBe(`LIVE org --help dir=${w.helpDir}\n`);
    expect(w.log()).toContain("HELP org help");
  });

  test("--help prints the CLI's own text under a state dir of its own, never frozen or refused", () => {
    const w = world({ frozen: ["*"] });
    const helpDir = w.helpDir;
    expect(w.cast("org", "--help")).toMatchObject({ code: 0, out: `LIVE org --help dir=${helpDir}\n` });
    expect(w.cast("task", "create", "--help").out).toBe(`LIVE task create --help dir=${helpDir}\n`);
    expect(w.cast("--help").out).toBe(`LIVE --help dir=${helpDir}\n`);
    expect(w.log()).toContain("HELP org --help");
    expect(w.log()).not.toContain("REFUSED");
    expect(w.log()).not.toContain("UNSERVED");
  });

  test("a --help commander would read as an option's value reaches only help, never the action or the real state", () => {
    const w = world();
    const helpDir = w.helpDir;
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
    // What a Bash command sees first on PATH after the user's profile shadowed it, once CLAUDE_ENV_FILE is sourced.
    '( PATH="/profile/bin:$PATH"; . "$CLAUDE_ENV_FILE"; printf "%s" "${PATH%%:*}" ) > "$FAKE_CLAUDE_REC/path-first"',
    // A command the agent runs, when the test gives one, with what it printed.
    '[ -z "${FAKE_CLAUDE_BASH:-}" ] || eval "$FAKE_CLAUDE_BASH" > "$FAKE_CLAUDE_REC/bash" 2>&1',
    'cat "$FAKE_CLAUDE_STREAM"',
    "",
  ].join("\n"), 0o755);
  write(path.join(dir, "stream.jsonl"), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // `--account fake` reads its token from the state dir, so no keychain is touched.
  write(path.join(state, "cc-token-fake.env"), "CLAUDE_CODE_OAUTH_TOKEN='fake-token'\n");
  write(path.join(dir, "prompt.md"), "Reply with the word ok.");
  write(path.join(dir, "system.md"), "Answer briefly.");
  const run = (...args: string[]) => runWith({}, ...args);
  const envWith = (extra: Record<string, string>) => ({ PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, CODECAST_DIR: state, FAKE_CLAUDE_REC: rec, FAKE_CLAUDE_STREAM: path.join(dir, "stream.jsonl"), ...extra });
  const runWith = (extra: Record<string, string>, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", HARNESS, ...args], { env: envWith(extra) });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  /** The same run, in flight alongside others. */
  const runAsync = async (extra: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn(["bun", HARNESS, ...args], { env: envWith(extra), stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code, err };
  };
  const recorded = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : null);
  return { dir, run, runWith, runAsync, recorded, runDir: path.join(dir, "run"), prompt: path.join(dir, "prompt.md"), system: path.join(dir, "system.md") };
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
      model: "m-pinned", call: true, maxOutputTokens: 20, tools: [], maxTurns: 1, serve: null, guard: path.join(import.meta.dir, "prompt-dry-run-bin"), isolation: null,
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
    expect(h.recorded("path-first")).toBe(path.join(path.dirname(HARNESS), "prompt-dry-run-bin"));
  }, 30_000);

  test("a cast the agent reaches around the guard, by an absolute path with no guard on PATH, still answers from the guard", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const main = path.join(import.meta.dir, "..", "src", "main.ts");
    const bash = `PATH=/usr/bin:/bin '${process.execPath}' '${main}' task create Something`;
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    expect(h.recorded("bash")).toContain("dry run: 'cast task create Something' would write, and is refused");
    expect(fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8")).toBe("task create Something\nREFUSED task create Something\n");
  }, 60_000);

  // ct-56832: two agents in flight both wrote /tmp/org_inputs.json and one graded the other's world.
  test.if(process.platform === "darwin")("two agent runs in flight cannot see each other's /tmp scratch, and each keeps its own under $TMPDIR", async () => {
    const shared = `/tmp/dry-run-isolation-${process.pid}.json`;
    fs.writeFileSync(shared, "planted outside");
    try {
      const agent = (id: string) => [
        `echo ${id} > ${shared} && echo tmp-write-ok || echo tmp-write-refused`,
        `cat ${shared} 2>&1 | sed 's/^/tmp-read: /'`,
        `echo ${id} > "$TMPDIR/x.json"`,
        "sleep 1",
        `echo "mine: $(cat "$TMPDIR/x.json")"`,
        `echo "claude-tmp: $CLAUDE_CODE_TMPDIR"`,
      ].join("; ");
      const result = [{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0 }];
      const [a, b] = [harnessWorld(result), harnessWorld(result)];
      const runs = await Promise.all([a, b].map((h, i) => h.runAsync({ FAKE_CLAUDE_BASH: agent(`agent-${i}`) }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake")));
      expect(runs.map((r) => r.code)).toEqual([0, 0]);
      for (const [i, h] of [a, b].entries()) {
        const said = h.recorded("bash")!;
        expect(said).toContain("tmp-write-refused");
        expect(said).toContain("Operation not permitted");
        expect(said).not.toContain("planted outside");
        expect(said).toContain(`mine: agent-${i}`);
        expect(said).not.toContain(`agent-${1 - i}`);
        expect(said).toContain(`claude-tmp: ${path.join(h.runDir, "tmp")}`);
        expect(JSON.parse(fs.readFileSync(path.join(h.runDir, "args.json"), "utf8")).isolation).toBe("sandbox-exec");
      }
      expect(fs.readFileSync(shared, "utf8")).toBe("planted outside");
    } finally {
      fs.rmSync(shared, { force: true });
    }
  }, 60_000);

  test("--isolation-check answers whether agent scratch is private here, and runs nothing else", () => {
    const r = Bun.spawnSync(["bun", HARNESS, "--isolation-check"], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir() } });
    if (process.platform === "darwin") expect({ code: r.exitCode, out: r.stdout.toString() }).toEqual({ code: 0, out: "isolated\n" });
    else expect(r.exitCode).toBe(3);
  }, 30_000);

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
