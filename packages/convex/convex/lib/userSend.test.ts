import { describe, expect, test } from "bun:test";
import { isUserMessageNoise, sendText, stripMessageTags, typedWords } from "./userSend";
import { AGENT_SETUP_CONTINUE_MESSAGE, HUDDLE_FEED_DISREGARD, huddleFeedBriefing, transcriptChunkHeader } from "@codecast/shared/contracts";
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
