import { describe, expect, it } from "bun:test";
import { cleanUserMessage, foldNudgeRuns, isBareNudge, nudgeLabel, type NudgeRow } from "../sessionMessage";

const interruptionNotice = "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.";

const interruptionMessages = [
  interruptionNotice,
  `<turn_aborted>\n${interruptionNotice}\n</turn_aborted>`,
  "  <turn_aborted>\nuser aborted\n</turn_aborted>  ",
  `<turn_aborted>\n${interruptionNotice.slice(0, 100)}`,
];

describe("cleanUserMessage", () => {
  it.each(interruptionMessages)("hides an automatic interruption notice: %s", (content) => {
    expect(cleanUserMessage(content)).toBeNull();
  });

  it("hides the [Codecast import] truncation banner from the inbox preview", () => {
    const banner =
      "[Codecast import] This Claude session was truncated to avoid overly-long context (which can break Claude Code /compact).\nWhat would you like to do next?";
    expect(cleanUserMessage(banner)).toBeNull();
  });

  it("keeps a real user message", () => {
    expect(cleanUserMessage("fix the login bug")).toBe("fix the login bug");
  });

  // The prompt that seated a standing agent read as the person's own words on
  // the inbox card ("You are **Gate test**, the standing agent for…"). The
  // shared recogniser the scope page cuts the thread on hides it here too.
  it("hides the seat's provisioning prompt from the preview", () => {
    expect(cleanUserMessage("You are **Gate test**, the standing agent for the **Gate test** role (@gate-test) in the Union workspace. You report to Ashot.")).toBeNull();
    expect(cleanUserMessage("You are **Anchor**, the **team** anchor for Union — every member can reach you")).toBeNull();
  });

  // The server truncates the preview slice, so a <task-notification> often
  // arrives with no closing tag; the inner text ("bnvc12ng6 Monitor event…")
  // was leaking into the card as if the human said it.
  it("hides a truncated task-notification with no closing tag", () => {
    const truncated =
      '<task-notification>\n<task-id>bnvc12ng6</task-id>\n<summary>Monitor event: "web dev server health (localhost:3200)"</summary>\n<event>dev server responding (200)</event>\nIf this event is something the us';
    expect(cleanUserMessage(truncated)).toBeNull();
  });
});

describe("isBareNudge", () => {
  it("matches the nudges a human types to keep the agent moving", () => {
    for (const s of ["continue", "Continue.", "go", "Go!", "go ahead", "keep going", "ok", "yes", "proceed", "next"]) {
      expect(isBareNudge(s)).toBe(true);
    }
  });

  it("keeps a real ask that merely starts with a nudge word", () => {
    for (const s of ["go fix the login bug", "continue with the migration", "ok but use the shared helper", "yes, and add a test"]) {
      expect(isBareNudge(s)).toBe(false);
    }
  });
});

describe("foldNudgeRuns", () => {
  const nudge = (id: string, text: string): NudgeRow => ({ id, nudge: nudgeLabel(text) });
  const said = (id: string): NudgeRow => ({ id, nudge: null });
  const hidden = (id: string): NudgeRow => ({ id, nudge: null, invisible: true });

  it("counts a run of identical nudges on its first row and folds the rest", () => {
    const { runs, folded, headOf } = foldNudgeRuns([nudge("a", "continue"), nudge("b", "Continue."), nudge("c", "continue")]);
    expect(runs.get("a")).toEqual({ text: "continue", count: 3 });
    expect([...folded]).toEqual(["b", "c"]);
    expect(headOf.get("a")).toBe("a");
    expect(headOf.get("b")).toBe("a");
    expect(headOf.get("c")).toBe("a");
  });

  it("gives a lone nudge its own head with a count of one", () => {
    const { runs, folded } = foldNudgeRuns([said("a"), nudge("b", "continue"), said("c")]);
    expect(runs.get("b")).toEqual({ text: "continue", count: 1 });
    expect(folded.size).toBe(0);
  });

  it("starts a new run when the human types a different nudge", () => {
    const { runs, folded } = foldNudgeRuns([nudge("a", "continue"), nudge("b", "go"), nudge("c", "go")]);
    expect(runs.get("a")!.count).toBe(1);
    expect(runs.get("b")).toEqual({ text: "go", count: 2 });
    expect([...folded]).toEqual(["c"]);
  });

  it("breaks the run on a message that renders, but not on one that renders nothing", () => {
    const withReply = foldNudgeRuns([nudge("a", "continue"), said("reply"), nudge("b", "continue")]);
    expect(withReply.runs.get("a")!.count).toBe(1);
    expect(withReply.runs.get("b")!.count).toBe(1);

    const withHidden = foldNudgeRuns([nudge("a", "continue"), hidden("toolresult"), nudge("b", "continue")]);
    expect(withHidden.runs.get("a")!.count).toBe(2);
    expect([...withHidden.folded]).toEqual(["b"]);
  });
});
