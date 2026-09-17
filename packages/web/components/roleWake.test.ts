import { describe, expect, test } from "bun:test";
import { causeLines, dedupeTitles, describeWake, isRoleWakeFrame, parseRoleWakeFrame } from "./roleWake";
import { cleanUserMessage } from "./sessionMessage";
import { ROLE_WAKE_FIXTURE, ROLE_WAKE_FIXTURE_LEGACY } from "./roleWakeFixture";

describe("parseRoleWakeFrame", () => {
  test("reads the tag, the sections in order, and the counts off the tag", () => {
    const f = parseRoleWakeFrame(ROLE_WAKE_FIXTURE)!;
    expect(f).toBeTruthy();
    expect(f.roleShortId).toBe("or-8");
    expect(f.wakeShortId).toBe("rw-12");
    expect(f.at).toBe(Date.parse("2026-09-15T04:01:55.078Z"));
    expect(f.causes).toBe(9);
    expect(f.held).toBe(2);
    expect(f.passive).toBe(1);
    expect(f.restart).toBe(false);
    expect(f.sections.map((s) => [s.key, s.title, s.lines.length])).toEqual([
      ["you", "You", 3],
      ["why", "Why you are awake", 8],
      ["scope", "Your scope now", 11],
      ["hands", "Hands say", 2],
      ["channels", "Channels", 1],
      ["charter", "Charter", 1],
    ]);
    expect(f.you).toEqual({
      name: "Reliability lead",
      handle: "reliability",
      trust: "understand",
      reportsTo: "Ashot Petrosian",
      scope: "project Codecast: Sync & Reliability, plan pl-497 Daemon scaling: unfreezable control plane, plan pl-592 Move Convex backend and Postgres off Railway",
      today: "1/40 wakes · 0/6 hands · 0/400000 tokens",
    });
    // The overflow line is not a cause.
    expect(causeLines(f.sections[1]).length).toBe(7);
    expect(describeWake(f)).toBe("woke on 9 changes, 2 held");
  });

  test("a frame without the counts on the tag counts its Why lines", () => {
    const f = parseRoleWakeFrame(ROLE_WAKE_FIXTURE_LEGACY)!;
    expect(f.wakeShortId).toBeUndefined();
    expect(f.causes).toBe(2);
    expect(f.held).toBe(0);
    expect(f.passive).toBe(1);
    expect(describeWake(f)).toBe("woke on 2 changes");
    expect(f.you?.name).toBe("Growth lead");
    expect(f.sections.find((s) => s.key === "scope")?.lines).toContain("Nothing in scope changed since your last frame.");
  });

  test("held lines count when the tag is silent; '(nothing queued)' is no cause", () => {
    const text = `<role-wake or-2 at="2026-09-15T04:01:55.078Z">\n## Why you are awake\n- (held) task ct-1 is done\n- (held) (passive) decision sd-2 answered\n- and 3 more changes\n</role-wake>`;
    const f = parseRoleWakeFrame(text)!;
    expect(f.causes).toBe(5);
    expect(f.held).toBe(2);
    expect(describeWake(f)).toBe("woke on 5 changes, 2 held");
    const empty = parseRoleWakeFrame(`<role-wake or-2 at="x">\n## Why you are awake\n- (nothing queued)\n</role-wake>`)!;
    expect(empty.causes).toBe(0);
    expect(empty.at).toBeNull();
    expect(describeWake(empty)).toBe("woke on nothing queued");
  });

  test("dedupeTitles drops the quoted title a pill already shows", () => {
    expect(dedupeTitles('task ct-51321 "Investigate repeated iOS crashes" is done')).toBe("task ct-51321 is done");
    expect(dedupeTitles('plan pl-592 "Move Convex" is draft (changed 3 times)')).toBe("plan pl-592 is draft (changed 3 times)");
    expect(dedupeTitles("a person wrote: \"ship it\"")).toBe("a person wrote: \"ship it\"");
  });

  test("a restart frame carries the charter and the brief in full", () => {
    const text = `<role-wake or-2 at="2026-09-15T04:01:55.078Z">\n## Why you are awake\n- restarted\n\n## Charter\n# Charter\nOwn reliability.\n\n## Brief\nstate line\nStatus: fine\n</role-wake>`;
    const f = parseRoleWakeFrame(text)!;
    expect(f.restart).toBe(true);
    expect(f.sections.map((s) => s.key)).toEqual(["why", "charter", "brief"]);
  });

  test("only a whole frame is a wake; trailing text or a torn frame is not", () => {
    expect(parseRoleWakeFrame(`${ROLE_WAKE_FIXTURE}\nand then some`)).toBeNull();
    expect(parseRoleWakeFrame(ROLE_WAKE_FIXTURE.slice(0, 400))).toBeNull();
    expect(parseRoleWakeFrame("hello <role-wake or-1 at=\"x\">")).toBeNull();
    expect(parseRoleWakeFrame(null)).toBeNull();
    // A system reminder wrapped around it by the harness does not hide it.
    expect(parseRoleWakeFrame(`<system-reminder>noise</system-reminder>\n${ROLE_WAKE_FIXTURE}`)?.roleShortId).toBe("or-8");
  });

  test("the shared predicate keys the frame off the human rail", () => {
    expect(isRoleWakeFrame(ROLE_WAKE_FIXTURE)).toBe(true);
    expect(isRoleWakeFrame(ROLE_WAKE_FIXTURE.slice(0, 60))).toBe(true);
    expect(isRoleWakeFrame("continue")).toBe(false);
    // Card previews never show the wire tag as the human's words.
    expect(cleanUserMessage(ROLE_WAKE_FIXTURE)).toBeNull();
  });
});

// ── Where a message went (scopes-and-feed.md F4.2) ──────────────────────────
import { handsStartedInTurn, personWrote, sentToRef } from "./roleWake";

describe("where a message went is derived from what the role did", () => {
  const at = Date.parse("2026-09-17T20:12:04.000Z");
  const hands = [
    { _id: "h_old", started_at: at - 60_000 },
    { _id: "h_second", started_at: at + 90_000 },
    { _id: "h_first", started_at: at + 30_000 },
    { _id: "h_next_turn", started_at: at + 600_000 },
  ];

  test("a wake claims the hands started inside its turn, oldest first, and nothing from before it", () => {
    expect(handsStartedInTurn(hands, at, at + 300_000).map((h) => h._id)).toEqual(["h_first", "h_second"]);
    // The latest turn runs to now.
    expect(handsStartedInTurn(hands, at, null).map((h) => h._id)).toEqual(["h_first", "h_second", "h_next_turn"]);
    // A frame with no time claims nothing rather than everything.
    expect(handsStartedInTurn(hands, null, null)).toEqual([]);
  });

  test("a cast send names the session it reached; flags before the id are skipped; other verbs are not a send", () => {
    expect(sentToRef({ category: "send", subcommand: "jx7h101", args: '"try the simplest revert first"' })).toBe("jx7h101");
    expect(sentToRef({ category: "send", subcommand: "", args: "--wake jx7h101 -" })).toBe("jx7h101");
    expect(sentToRef({ category: "spawn", subcommand: "", args: '"get CI green"' })).toBeNull();
    expect(sentToRef({ category: "send", subcommand: "-", args: "" })).toBeNull();
    expect(sentToRef(null)).toBeNull();
  });

  test("a frame says when a person wrote, and the fixture (system causes only) does not", () => {
    const wrote = ROLE_WAKE_FIXTURE.replace("## Why you are awake\n", "## Why you are awake\n- Ashot Petrosian wrote:\nremember the release moved to Friday\n");
    expect(personWrote(parseRoleWakeFrame(wrote)!)).toBe(true);
    expect(personWrote(parseRoleWakeFrame(ROLE_WAKE_FIXTURE)!)).toBe(false);
  });
});
