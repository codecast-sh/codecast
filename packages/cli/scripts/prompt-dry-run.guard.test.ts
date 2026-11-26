// The guard `cast` of the prompt dry run (prompt-dry-run-bin/cast), run as a
// subprocess with no network and a fake real `cast`: the served-read cassette
// (docs/architecture/evals-home.md 2.6), read and write classification, help,
// and what calls.log records. The harness itself is tested in the
// prompt-dry-run.*.guard.test.ts files beside this one.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loggedArgv, servedReadKey } from "../../evals/src/served.ts";
import { GUARD, logged, TREE, type TreeEntry, world, write } from "./prompt-dry-run.guard-helpers.ts";

// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);

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
    expect(classify("connector", "readers", "acme")).toBe("read");
    expect(classify("connector", "resolve", "acme", "x")).toBe("write");
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
