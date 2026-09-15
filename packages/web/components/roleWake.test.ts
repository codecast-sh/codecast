import { describe, expect, test } from "bun:test";
import { causeLines, describeWake, isRoleWakeFrame, parseRoleWakeFrame } from "./roleWake";
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
