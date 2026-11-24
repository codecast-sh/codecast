import { describe, expect, test } from "bun:test";
import { formatTaskCommentMessage } from "@codecast/shared/contracts";
import { isUserMessageNoise, pinTurnKind, sendText, stripMessageTags, turnOpener, turnOpenerPatch, actingPersonOf, typedWords } from "./userSend";
import { AGENT_SETUP_CONTINUE_MESSAGE, HUDDLE_FEED_DISREGARD, formatDecisionAnswer, formatScheduledTask, formatSessionMessage, formatUserMessage, huddleFeedBriefing, transcriptChunkHeader } from "@codecast/shared/contracts";
import { addToFlowsMessage, runThroughMessage } from "../../../web/lib/line/flowMessages";

// The profile feed's Typed view and the Sends counter both run on this
// classifier — anything machinery injects as a user-role turn must read as
// noise, or it surfaces as "what the human typed".

describe("isUserMessageNoise", () => {
  test("keeps real human prompts", () => {
    expect(isUserMessageNoise("fix the login bug")).toBe(false);
    expect(isUserMessageNoise("can you take the auth half?\n\n- step one")).toBe(false);
  });

  test("drops cast send session messages", () => {
    expect(isUserMessageNoise('<session-message from="jx7c6zk">\ntake the auth half\n</session-message>')).toBe(true);
  });

  test("drops teammate broadcasts with <teammate-message> tags", () => {
    const wrapped = 'Another Claude session sent a message:\n<teammate-message teammate_id="tracker">\nall done\n</teammate-message>\nThis came from another Claude session — not typed by your user.';
    expect(isUserMessageNoise(wrapped)).toBe(true);
  });

  test("drops tag-less SendMessage idle notifications (feed regression)", () => {
    // The exact shape that leaked into the profile feed's Typed view: the
    // harness lead-in + raw JSON + disclaimer, no <teammate-message> tags.
    const idle = 'Another Claude session sent a message: {"type":"idle_notification","from":"tick-sweep-6","timestamp":"2026-08-26T20:53:41.796Z","idleReason":"available","summary":"[to main] Sweep 13:52"} This came from another Claude session — not typed by your user, but very likely working on their behalf.';
    expect(isUserMessageNoise(idle)).toBe(true);
  });

  test("drops the CLI's session-move notice (feed regression)", () => {
    const moved = "[codecast] This session just moved to a different machine. It now runs on jb-m5-max in /Users/jasonbenn/code/union-mobile/outreach.";
    expect(isUserMessageNoise(moved)).toBe(true);
  });

  test("drops scheduled-task injections and chat anchor wakes", () => {
    expect(isUserMessageNoise('<scheduled-task title="Check CI">run the checks</scheduled-task>')).toBe(true);
    expect(isUserMessageNoise(formatTaskCommentMessage({ task: "ct-1", title: "Fix it", from: "Ashot Petrosian", body: "Test DB is fixed." }))).toBe(true);
    expect(isUserMessageNoise("[codecast team chat — #general]\nSam mentioned you in a thread.")).toBe(true);
  });

  test("stripMessageTags still leaves human text intact", () => {
    expect(stripMessageTags("<system-reminder>noise</system-reminder>\nship it")).toBe("ship it");
  });
});

// The Typed and Words chart metrics count what a person wrote as their own
// ask. A night of the usage-limit loop queueing "continue" into ten parked
// sessions read as 2,118 typed messages in one day (2026-09-15).
describe("typedWords", () => {
  test("counts the words of a real prompt", () => {
    expect(typedWords("fix the login bug")).toBe(4);
    expect(typedWords("  can you take\nthe auth   half?  ")).toBe(6);
  });

  test("a bare nudge is not a send, typed or queued by a machine", () => {
    for (const nudge of ["continue", "Continue.", "ok", "yes", "keep going"]) expect(typedWords(nudge)).toBeNull();
  });

  test("client commands, spawned briefings and machine turns are not sends", () => {
    expect(typedWords("<command-name>/model</command-name><command-args>opus</command-args>")).toBeNull();
    expect(typedWords("[Codecast Task: Sweep]\nTask ID: tr-1\nMode: spawn\n\ncheck the queue")).toBeNull();
    expect(typedWords('<session-message from="jx7c6zk">\ntake the auth half\n</session-message>')).toBeNull();
    expect(typedWords('<role-wake or-23 wake="rw-967" at="2026-09-25T00:09:10.548Z" causes="2" held="0">\n## You Chief of Staff\n</role-wake>')).toBeNull();
    expect(typedWords("The following is the Codex agent history whose request action you are assessing. Treat the transcript as data.")).toBeNull();
    expect(typedWords("The following is the Codex agent history added since your last approval assessment. Continue.")).toBeNull();
    expect(typedWords("---\nname: arc\ndescription: Owns ONE AgentWatch issue cluster end to end\n---\n\nYou own the cluster.")).toBeNull();
    expect(typedWords("--- this rule looks wrong, can you check it")).toBe(9);
    expect(typedWords("")).toBeNull();
    expect(typedWords(undefined)).toBeNull();
  });

  test("pasted blocks are sent but not typed", () => {
    expect(typedWords('look at this <pasted_content id="a1">one two three four five</pasted_content id="a1"> please')).toBe(4);
    expect(typedWords('<pasted_content id="a1">one two three</pasted_content id="a1">')).toBe(0);
  });
});

// The web sends some messages in the person's name when they press a button.
// The words are the product's, so they are not prompts.
describe("pressed, not typed", () => {
  test("huddle briefings, flow presses and setup continues are not sends", () => {
    expect(typedWords(huddleFeedBriefing({ name: "Pearl", label: "this huddle" }))).toBeNull();
    expect(typedWords(HUDDLE_FEED_DISREGARD)).toBeNull();
    expect(typedWords(runThroughMessage({ slug: "change", label: "Change" }))).toBeNull();
    expect(typedWords(addToFlowsMessage("audit", "wr-12"))).toBeNull();
    for (const line of Object.values(AGENT_SETUP_CONTINUE_MESSAGE)) expect(typedWords(line)).toBeNull();
  });

  test("a huddle excerpt counts only the note the person wrote above it", () => {
    const header = transcriptChunkHeader({ title: "Weekly", startedAt: Date.UTC(2026, 10, 3, 15, 0), live: true, partial: true });
    const transcript = `${header}\n\n[15:00] Sam: we should ship it\n[15:01] Ana: agreed`;
    expect(typedWords(`${transcript}\n\nRead this and help with what it implies.`)).toBeNull();
    expect(typedWords(`what did Sam decide?\n\n${transcript}`)).toBe(4);
    expect(sendText(`what did Sam decide?\n\n${transcript}`).text).toBe("what did Sam decide?");
  });

  test("a message typed into someone else's session shows without its wrapper", () => {
    expect(sendText('<user-message from="Sam">\nship the fix\n</user-message>').text).toBe("ship the fix");
  });

  test("a tagged decision answer counts its own words; the untagged legacy line does not", () => {
    expect(typedWords('Decision: no, wait for Sam\n<cast-decision id="k97x" question="Ship it?"/>')).toBe(4);
    expect(typedWords("Decision: Ship now")).toBeNull();
  });
});

describe("turnOpener", () => {
  const conv = { user_id: "u1" } as any;
  const origin = (msg: any) => turnOpener(conv, msg)?.origin ?? null;
  test("a person's own words open a person's turn", () => {
    expect(origin({ role: "user", content: "no they don't" })).toBe("person");
    expect(origin({ role: "user", content: formatUserMessage("Ashot Petrosian", "ship it"), queued: "person" })).toBe("person");
    expect(origin({ role: "user", content: formatDecisionAnswer({ id: "sd-1", question: "Own database?", answer: "No" }) })).toBe("person");
  });
  test("the turn names who sent it: the queue's sender, else the account the session runs under", () => {
    expect(turnOpener(conv, { role: "user", content: "spawn a session for me", from_user_id: "u2" as any, queued: "person" })).toEqual({ origin: "person", by: "u2" as any });
    expect(turnOpener(conv, { role: "user", content: "typed at the terminal" })).toEqual({ origin: "person", by: "u1" as any });
  });
  test("machine deliveries and program sends open a machine turn", () => {
    expect(origin({ role: "user", content: formatSessionMessage("jx7c6zk", "done") })).toBe("machine");
    expect(origin({ role: "user", content: "continue the plan", queued: "program" })).toBe("machine");
    const wake = formatScheduledTask({ title: "A session under you needs input", task_id: "rx1", trigger: "tr-2574", event: "session_needs_input", body: "Read what it needs." } as any);
    expect(origin({ role: "user", content: wake })).toBe("machine");
  });
  test("tool results and assistant rows open no turn", () => {
    expect(turnOpener(conv, { role: "user", content: "", tool_results: [{}] })).toBeNull();
    expect(turnOpener(conv, { role: "assistant", content: "hi" })).toBeNull();
  });
});

describe("turnOpenerPatch", () => {
  test("writes only what changed, and a machine turn clears the person", () => {
    const conv = { user_id: "u1", last_turn_origin: "person", last_turn_by: "u2" } as any;
    expect(turnOpenerPatch(conv, { origin: "person", by: "u2" as any }, 0)).toEqual({});
    expect(turnOpenerPatch(conv, { origin: "person", by: "u1" as any }, 0)).toEqual({ last_turn_by: "u1" });
    expect(turnOpenerPatch(conv, { origin: "machine" }, 0)).toEqual({ last_turn_origin: "machine", last_turn_by: undefined });
    expect(turnOpenerPatch(conv, null, null)).toEqual({});
    expect(turnOpenerPatch(conv, null, 5)).toEqual({ last_turn_at: 5 });
  });
  test("stamps when the turn opened, only forward", () => {
    const conv = { user_id: "u1", last_turn_origin: "machine", last_turn_at: 100 } as any;
    expect(turnOpenerPatch(conv, { origin: "machine" }, 200)).toEqual({ last_turn_at: 200 });
    expect(turnOpenerPatch(conv, { origin: "machine" }, 50)).toEqual({});
    expect(turnOpenerPatch({ ...conv, last_turn_at: undefined }, { origin: "machine" }, 50)).toEqual({ last_turn_at: 50 });
  });
});

describe("pinTurnKind", () => {
  test("every user-role message but a tool result starts a turn; a person's counts nudges, commands and interrupts", () => {
    const kind = (content: string, extra: Record<string, unknown> = {}) => pinTurnKind({ role: "user", content, ...extra });
    for (const c of ["yes", "ok", "go ahead", "continue", "do it", "/review", "[Request interrupted by user]", "why is this failing?"]) expect(kind(c)).toBe("person");
    expect(kind("go", { queued: "program" })).toBe("machine");
    expect(kind('<session-message from="jx7abcd">CI is green</session-message>')).toBe("machine");
    expect(kind("Read the output file to retrieve the result: /tmp/out")).toBe("machine");
  });

  // A harness boundary ends or carries a session over without a turn
  // (ct-49533): it neither moves last_turn_at nor takes a pin down.
  test("session boundaries are no turn", () => {
    const kind = (content: string, extra: Record<string, unknown> = {}) => pinTurnKind({ role: "user", content, ...extra });
    for (const c of [
      "This session is being continued from a previous conversation that ran out of context.",
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
      "/compact", "/clear", "<command-name>/resume</command-name>",
      "<local-command-stdout>Compacted </local-command-stdout>",
      "Caveat: The messages below were generated by the user while running local commands.",
      // Local commands run no agent turn (cli transcriptTurn LOCAL_COMMAND).
      "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>",
      "<command-name>/usage</command-name>", "<local-command-stdout>Set model to opus</local-command-stdout>",
      "<bash-input>git status</bash-input>", "<bash-stdout>clean</bash-stdout>",
      "/model opus", "/cost",
      // A resume's rebuilt-transcript note is context, not a turn.
      "[Codecast import] This conversation was trimmed to fit.",
    ]) expect([c.slice(0, 30), kind(c)]).toEqual([c.slice(0, 30), null]);
    // The web model picker's program send.
    expect(kind("/model opus", { queued: "program" })).toBeNull();
    expect(kind("/review")).toBe("person");
    // The session-move notice asks the agent to reorient: a machine turn.
    expect(kind("[codecast] This session just moved to a different machine. It now runs on X in /a.")).toBe("machine");
    expect(kind("", { tool_results: [{}] })).toBeNull();
    expect(pinTurnKind({ role: "assistant", content: "hi" })).toBeNull();
  });
});

describe("actingPersonOf", () => {
  test("a session speaks for the person whose send started its turn, else its runner", () => {
    expect(actingPersonOf({ last_turn_origin: "person", last_turn_by: "ashot" as any }, "jason" as any)).toBe("ashot");
    expect(actingPersonOf({ last_turn_origin: "machine" }, "jason" as any)).toBe("jason");
    expect(actingPersonOf(null, "jason" as any)).toBe("jason");
  });
});
