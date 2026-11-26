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
  doneAskLabel,
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

  test("nothing to say when the server names no milestone (not done, --serves given, or linked to none)", () => {
    expect(servesHint({})).toBeNull();
    expect(servesHint({ milestone: null })).toBeNull();
  });
});

describe("a Done pin that hands the person something", () => {
  test("doneAskLabel: a Done pin with an ask line the card would show", () => {
    const withYou = "Shipped the fix\nYou: pick the rollout day";
    expect(doneAskLabel("done", withYou)).toBe("You");
    expect(doneAskLabel("done", "Shipped\n   You: reopen Chrome")).toBe("You");
    expect(doneAskLabel("done", "Shipped\n- You: pick a day")).toBe("You");
    expect(doneAskLabel("done", "Shipped\n* You: pick a day")).toBe("You");
    expect(doneAskLabel("done", "Shipped\n• You: pick a day")).toBe("You");
    expect(doneAskLabel("done", "Shipped\nBlocked: needs your key")).toBe("Blocked");
    expect(doneAskLabel("done", "You: pick the rollout day")).toBe("You");
    expect(doneAskLabel("blocked", withYou)).toBeNull();
    expect(doneAskLabel("dormant", withYou)).toBeNull();
    expect(doneAskLabel("working", withYou)).toBeNull();
    expect(doneAskLabel("done", "Shipped\nDone: tests green")).toBeNull();
    expect(doneAskLabel("done", "Shipped\nDone: wrote the You: line guidance")).toBeNull();
  });

  test("doneAskLabel: a station's fenced json report is not an ask, as on the card", () => {
    expect(doneAskLabel("done", 'Proven\n```json\n{\n"note": "x"\n}\nYou: not a row\n```')).toBeNull();
  });

  // Drive the real command: fake endpoint, fetch recorded, exit trapped, and
  // the pulse/stamp files under a throwaway CODECAST_DIR.
  const session = "fixturesessionaaaa";
  let dir: string;
  let posts: string[];
  let errors: string[];
  const saved = { fetch: globalThis.fetch, exit: process.exit, error: console.error, log: console.log, dir: process.env.CODECAST_DIR };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-refusal-"));
    process.env.CODECAST_DIR = dir;
    posts = [];
    errors = [];
    globalThis.fetch = (async (url: string) => {
      posts.push(String(url));
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

  test("done without a You: line is pinned, even with You: mid-line", async () => {
    expect(await runState("--status", "done", "Shipped\nDone: reworded the You: guidance")).toBeNull();
    expect(errors).toEqual([]);
    expect(posts).toEqual(["https://fixture.invalid/cli/sessions/state/set"]);
    expect(fs.existsSync(threadStateStampPath(session))).toBe(true);
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
