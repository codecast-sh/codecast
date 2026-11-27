import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Command } from "commander";
import {
  parseStateArgs,
  formatAge,
  describeProvenance,
  staleStateNotice,
  statusTag,
  servesHint,
  buriedAskLabel,
  waitingOnArg,
  personAskArg,
  registerStateCommand,
} from "./stateCommand.js";
import { threadStateStampPath } from "./threadStateStamp.js";

describe("servesHint", () => {
  test("a done pin in a session linked to a milestone, without --serves, says how to close it", () => {
    expect(servesHint({ milestone: { serves: "pri-3/s2", title: "Grader in CI" } })).toBe("Linked to pri-3/s2 Grader in CI: if this finished it, re-pin with --serves pri-3/s2");
  });

  test("a done pin whose --serves names another milestone than the session's says it closed nothing", () => {
    expect(servesHint({ serves_mismatch: { serves: "pri-3/s2", milestone: "pri-4/s1" } })).toBe("--serves pri-3/s2 doesn't match this session's milestone pri-4/s1; nothing closed");
  });

  test("a done pin naming its milestone that closed nothing says why", () => {
    expect(servesHint({ serves_refused: { serves: "pri-3/s2", reason: "worker" } })).toBe("--serves pri-3/s2: a worker's pin doesn't close a milestone; the session that started it closes it");
    expect(servesHint({ serves_refused: { serves: "pri-3/s2", reason: "done" } })).toBe("--serves pri-3/s2 is already done; nothing changed");
    expect(servesHint({ serves_decided_by: "tasks" }, "pri-3/s2")).toBe("pri-3/s2 closes when its tasks close; the pin closed nothing");
    expect(servesHint({ serves_decided_by: "pull_requests" }, "pri-3/s2")).toBe("pri-3/s2 closes when its pull requests merge; the pin closed nothing");
  });

  test("a done pin naming a milestone from a session on none yet is kept, and says so", () => {
    expect(servesHint({ serves_unlinked: { serves: "pri-3/s2" } })).toBe("this session isn't on pri-3 yet; the pin is kept and counts once it's linked");
  });

  test("nothing to say when the server names no milestone (not done, --serves given, or linked to none)", () => {
    expect(servesHint({})).toBeNull();
    expect(servesHint({ milestone: null })).toBeNull();
  });
});

describe("a Done pin that hands the person something", () => {
  test("buriedAskLabel: a Done pin with an ask line the card would show", () => {
    const withYou = "Shipped the fix\nYou: pick the rollout day";
    expect(buriedAskLabel("done", withYou)).toBe("You");
    expect(buriedAskLabel("done", "Shipped\n   You: reopen Chrome")).toBe("You");
    expect(buriedAskLabel("done", "Shipped\n- You: pick a day")).toBe("You");
    expect(buriedAskLabel("done", "Shipped\n* You: pick a day")).toBe("You");
    expect(buriedAskLabel("done", "Shipped\n• You: pick a day")).toBe("You");
    expect(buriedAskLabel("done", "Shipped\nBlocked: needs your key")).toBe("Blocked");
    expect(buriedAskLabel("done", "You: pick the rollout day")).toBe("You");
    expect(buriedAskLabel("blocked", withYou)).toBeNull();
    expect(buriedAskLabel("dormant", withYou)).toBe("You");
    expect(buriedAskLabel("working", withYou)).toBeNull();
    expect(buriedAskLabel("done", "Shipped\nDone: tests green")).toBeNull();
    expect(buriedAskLabel("done", "Shipped\nDone: wrote the You: line guidance")).toBeNull();
  });

  test("buriedAskLabel: a station's fenced json report is not an ask, as on the card", () => {
    expect(buriedAskLabel("done", 'Proven\n```json\n{\n"note": "x"\n}\nYou: not a row\n```')).toBeNull();
  });

  // Drive the real command: fake endpoint, fetch recorded, exit trapped, and
  // the pulse/stamp files under a throwaway CODECAST_DIR.
  const session = "fixturesessionaaaa";
  let dir: string;
  let posts: string[];
  let bodies: any[];
  let errors: string[];
  const saved = { fetch: globalThis.fetch, exit: process.exit, error: console.error, log: console.log, dir: process.env.CODECAST_DIR };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-refusal-"));
    process.env.CODECAST_DIR = dir;
    posts = [];
    bodies = [];
    errors = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      posts.push(String(url));
      bodies.push(init?.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify({ short_id: "jxfixt1", status: "blocked" }), { status: 200 });
    }) as unknown as typeof fetch;
    process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    console.log = () => {};
  });

  afterEach(() => {
    globalThis.fetch = saved.fetch;
    process.exit = saved.exit;
    console.error = saved.error;
    console.log = saved.log;
    if (saved.dir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = saved.dir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runState(...argv: string[]): Promise<string | null> {
    const program = new Command().exitOverride();
    registerStateCommand(program, {
      getCliEndpoint: () => ({ siteUrl: "https://fixture.invalid", apiToken: "t" }),
      detectCurrentSessionId: () => session,
    });
    try {
      await program.parseAsync(["state", ...argv], { from: "user" });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  test("done with a You: line exits non-zero and writes nothing", async () => {
    expect(await runState("--status", "done", "Shipped the fix\nYou: pick the rollout day")).toBe("exit 1");
    expect(errors).toEqual([
      "A You: line means the person acts. Use --status blocked.",
    ]);
    expect(posts).toEqual([]);
    expect(fs.existsSync(threadStateStampPath(session))).toBe(false);
  });

  test("done with a bulleted Blocked: line is refused with its label", async () => {
    expect(await runState("--status", "done", "Shipped\n- Blocked: needs your key")).toBe("exit 1");
    expect(errors).toEqual(["A Blocked: line means the person acts. Use --status blocked."]);
    expect(posts).toEqual([]);
    expect(fs.existsSync(threadStateStampPath(session))).toBe(false);
  });

  test("blocked with a You: line is pinned", async () => {
    expect(await runState("--status", "blocked", "Waiting on a key\nYou: add it to the secrets")).toBeNull();
    expect(posts).toEqual(["https://fixture.invalid/cli/sessions/state/set"]);
    expect(fs.existsSync(threadStateStampPath(session))).toBe(true);
  });

  test("dormant with a You: line is refused the same way: Sleeping would bury the ask", async () => {
    expect(await runState("--status", "dormant", "Waiting on CI\nYou: approve the deploy")).toBe("exit 1");
    expect(errors).toEqual(["A You: line means the person acts. Use --status blocked."]);
    expect(posts).toEqual([]);
  });

  test("--on sends what the dormant pin waits on, in its stored form", async () => {
    expect(await runState("--status", "dormant", "--on", "CT-012", "Waiting on the builder")).toBeNull();
    expect(await runState("--status", "dormant", "--on", "JX7c6zk", "Waiting on the builder")).toBeNull();
    expect(await runState("--status", "dormant", "--on", "https://github.com/Codecast-SH/codecast/pull/42", "Waiting on the merge")).toBeNull();
    expect(await runState("--status", "dormant", "--on", "@Ashot", "--ask", "Which region?", "Waiting on Ashot")).toBeNull();
    expect(bodies.map((b) => b.on)).toEqual(["ct-12", "jx7c6zk", "codecast-sh/codecast#42", "@ashot"]);
    expect(errors).toEqual([]);
  });

  test("--on @person asks them: without --ask it is refused before any write", async () => {
    expect(await runState("--status", "dormant", "--on", "@ashot", "Waiting on Ashot")).toBe("exit 1");
    expect(errors[0]).toContain('--on @ashot asks them a question');
    expect(errors[0]).toContain('--ask "<question>"');
    expect(await runState("--status", "dormant", "--on", "ct-12", "--ask", "Which?", "Waiting")).toBe("exit 1");
    expect(errors[1]).toContain("--ask and -o go with a wait on a person");
    expect(await runState("--status", "dormant", "-o", "US", "Waiting")).toBe("exit 1");
    expect(posts).toEqual([]);
  });

  test("--ask and its options ride the pin, read like cast decide -o", async () => {
    expect(await runState("--status", "dormant", "--on", "@ashot", "--ask", "Which region?", "-o", "US", "-o", "EU :: closer to the customer", "Waiting on Ashot")).toBeNull();
    expect(bodies[0]).toMatchObject({ on: "@ashot", ask: "Which region?", options: [{ label: "US" }, { label: "EU", description: "closer to the customer" }] });
    expect(await runState("--status", "dormant", "--on", "@ashot", "--ask", "Which region?", "Waiting on Ashot")).toBeNull();
    expect(bodies[1].options).toBeUndefined();
  });

  test("a pin without --on sends none, which clears the wait", async () => {
    expect(await runState("--status", "dormant", "Waiting on CI")).toBeNull();
    expect(bodies[0].on).toBeUndefined();
  });

  test("--on with any status but dormant, or a ref that waits on nothing, is refused before any write", async () => {
    expect(await runState("--status", "done", "--on", "ct-12", "Shipped")).toBe("exit 1");
    expect(await runState("--on", "ct-12", "Building")).toBe("exit 1");
    expect(await runState("--status", "dormant", "--on", "2h", "Later")).toBe("exit 1");
    expect(await runState("--status", "dormant", "--on", "#42:checks", "CI")).toBe("exit 1");
    expect(await runState("--status", "dormant", "--on", "sd-4", "A card")).toBe("exit 1");
    expect(errors[0]).toContain("--on names what a dormant session waits on");
    expect(errors[1]).toContain("--status dormant");
    expect(errors[3]).toContain("pr_checks_green");
    expect(errors[4]).toContain("no --on needed");
    expect(posts).toEqual([]);
  });

  test("done without a You: line is pinned, even with You: mid-line", async () => {
    expect(await runState("--status", "done", "Shipped\nDone: reworded the You: guidance")).toBeNull();
    expect(errors).toEqual([]);
    expect(posts).toEqual(["https://fixture.invalid/cli/sessions/state/set"]);
    expect(fs.existsSync(threadStateStampPath(session))).toBe(true);
  });
});

describe("waitingOnArg", () => {
  test("a bare #42 takes the checkout's repository, and is refused outside one", async () => {
    expect(await waitingOnArg("#42", "dormant", async () => "Codecast-SH/codecast")).toEqual({ on: "codecast-sh/codecast#42" });
    expect((await waitingOnArg("#42", "dormant", async () => undefined)).error).toContain("owner/repo#42");
  });

  test("no --on, nothing sent", async () => {
    expect(await waitingOnArg(undefined, "dormant", async () => undefined)).toEqual({});
  });
});

describe("personAskArg", () => {
  test("a person needs the question; nothing else takes one", () => {
    expect(personAskArg("@ashot", "  Which?  ", [])).toEqual({ ask: "Which?" });
    expect(personAskArg("@ashot", "  ", []).error).toContain("--ask");
    expect(personAskArg("ct-12", undefined, [])).toEqual({});
    expect(personAskArg(undefined, "Q", []).error).toContain("go with a wait on a person");
    expect(personAskArg("@ashot", "Q", Array.from({ length: 10 }, (_, i) => `o${i}`)).error).toContain("nine");
  });
});

describe("statusTag", () => {
  test("labels each declared status, colored", () => {
    expect(statusTag("working")).toContain("[in progress]");
    expect(statusTag("blocked")).toContain("[needs you]");
    expect(statusTag("done")).toContain("[complete]");
  });

  test("rows that predate the status get no tag", () => {
    expect(statusTag(null)).toBe("");
    expect(statusTag(undefined)).toBe("");
    expect(statusTag("junk")).toBe("");
  });
});

describe("parseStateArgs", () => {
  test("no args reads the current state", () => {
    expect(parseStateArgs([])).toEqual({ mode: "show", session: undefined });
  });

  test("a bare string is the state text", () => {
    expect(parseStateArgs(["Waiting on CI"])).toEqual({
      mode: "set",
      text: "Waiting on CI",
      session: undefined,
    });
  });

  test("clear words remove the state", () => {
    for (const word of ["clear", "rm", "unset", "none", "CLEAR"]) {
      expect(parseStateArgs([word]).mode).toBe("clear");
    }
  });

  test("a bare \"done\" is state text, not a clear — the agent may mean it", () => {
    expect(parseStateArgs(["done"])).toEqual({ mode: "set", text: "done", session: undefined });
  });

  test("a clear word followed by more text is text, not a clear", () => {
    expect(parseStateArgs(["done", "with", "the", "migration"])).toEqual({
      mode: "set",
      text: "done with the migration",
      session: undefined,
    });
  });

  test("text that merely starts with a verb-like word stays text", () => {
    expect(parseStateArgs(["cleared the queue, waiting"]).mode).toBe("set");
  });

  test("explicit set takes the rest as text", () => {
    expect(parseStateArgs(["set", "Blocked: needs a key"])).toEqual({
      mode: "set",
      text: "Blocked: needs a key",
      session: undefined,
    });
  });

  test("show takes an optional session and beats --for", () => {
    expect(parseStateArgs(["show", "jx7c6zk"], "jx7other")).toEqual({
      mode: "show",
      session: "jx7c6zk",
    });
    expect(parseStateArgs(["show"], "jx7other")).toEqual({ mode: "show", session: "jx7other" });
  });

  test("--for targets a write at another session", () => {
    expect(parseStateArgs(["Waiting on CI"], "jx7c6zk")).toEqual({
      mode: "set",
      text: "Waiting on CI",
      session: "jx7c6zk",
    });
  });
});

describe("formatAge", () => {
  test("reads naturally across the scale", () => {
    expect(formatAge(10_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatAge(60 * 60_000)).toBe("1 hour ago");
    expect(formatAge(5 * 60 * 60_000)).toBe("5 hours ago");
    expect(formatAge(26 * 60 * 60_000)).toBe("1 day ago");
    expect(formatAge(72 * 60 * 60_000)).toBe("3 days ago");
  });
});

describe("describeProvenance", () => {
  const now = 1_700_000_000_000;

  test("reports age and the message gap", () => {
    const line = describeProvenance(
      { at: now - 5 * 60_000, msg_count_at_write: 100, message_count: 103 },
      now,
    );
    expect(line).toBe("set 5 min ago, 3 messages since");
  });

  test("singular message reads correctly", () => {
    const line = describeProvenance(
      { at: now - 60_000, msg_count_at_write: 10, message_count: 11 },
      now,
    );
    expect(line).toContain("1 message since");
  });

  test("a far-behind state says so out loud", () => {
    const line = describeProvenance(
      { at: now - 60_000, msg_count_at_write: 0, message_count: 500 },
      now,
    );
    expect(line).toContain("likely stale");
  });

  test("a row with no stored count omits the gap rather than claiming zero", () => {
    const line = describeProvenance({ at: now - 60_000, message_count: 500 }, now);
    expect(line).toBe("set 1 min ago");
  });
});

// The reminder that rides along with `cast task done` / `start` / `plan
// comment`. It must stay silent unless there is a state AND the thread has run
// past it — a nudge on a fresh state trains the agent to ignore the channel.
describe("staleStateNotice", () => {
  const now = 1_700_000_000_000;

  test("no pinned state means no reminder", () => {
    expect(staleStateNotice(null, now)).toBeNull();
    expect(staleStateNotice({ state: null, message_count: 900 }, now)).toBeNull();
  });

  test("a fresh state is not worth a reminder", () => {
    expect(
      staleStateNotice(
        { state: "Waiting on CI", at: now - 60_000, msg_count_at_write: 100, message_count: 105 },
        now,
      ),
    ).toBeNull();
  });

  test("a thread that ran past the state earns one line with the real gap", () => {
    const notice = staleStateNotice(
      { state: "Waiting on CI", at: now - 60_000, msg_count_at_write: 100, message_count: 400 },
      now,
    );
    expect(notice).toContain("300 messages old");
    expect(notice).toContain("cast state");
  });

  test("a row with no write-time count falls back to age, never a made-up gap", () => {
    const notice = staleStateNotice(
      { state: "Waiting on CI", at: now - 72 * 3_600_000, message_count: 400 },
      now,
    );
    expect(notice).toContain("set 3 days ago");
    expect(notice).not.toContain("messages old");
  });
});
