import { describe, expect, test } from "bun:test";
import { verifyTmuxSubmitAfterPaste, type TmuxSubmitVerifyIO } from "./daemon.js";

// Regression coverage for the cold-boot inject race (conversation jx7ev2w):
// a freshly spawned Claude renders its shell within ~1s but doesn't consume
// stdin for several more seconds. The paste sits pty-buffered (pane frozen),
// and when the buffer drains the queued Enter is coalesced into the paste
// burst — so the message sits in the composer unsubmitted. The verify loop
// must keep watching through the frozen phase and press a discrete Enter
// once the text appears, instead of exiting early.

const PROMPT = "settings ui looks like crap - also it is";

const BOOT_PANE = `
 ▐▛███▜▌   Claude Code v2.1.175
▝▜█████▛▘  Fable 5 with high effort · Claude Max

────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ don't ask on (shift+tab to cycle)
`;

const STUCK_PANE = `
 ▐▛███▜▌   Claude Code v2.1.175
▝▜█████▛▘  Fable 5 with high effort · Claude Max

────────────────────────────────────────
❯ settings ui looks like crap - also it is slow also its broken
────────────────────────────────────────
  ⏵⏵ don't ask on (shift+tab to cycle)
`;

const WORKING_PANE = `
❯ settings ui looks like crap - also it is slow also its broken

· Osmosing… (3s · ↓ 120 tokens)
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ don't ask on · esc to interrupt
`;

const EXITED_PANE = `
Resume this session with: claude --resume abc
$
`;

// Builds an IO whose capture() walks through `frames` (sticking on the last),
// recording every action the loop takes.
function scriptedIO(frames: string[]) {
  const actions: string[] = [];
  let i = 0;
  const io: TmuxSubmitVerifyIO = {
    capture: async () => {
      const frame = frames[Math.min(i, frames.length - 1)];
      i++;
      return frame;
    },
    sendEnter: async () => {
      actions.push("enter");
    },
    rePaste: async () => {
      actions.push("repaste");
    },
    sleep: async () => {},
    log: () => {},
  };
  return { io, actions };
}

describe("verifyTmuxSubmitAfterPaste", () => {
  test("cold boot: waits through frozen pane, presses Enter when text appears, confirms submit", async () => {
    // Pane frozen (identical to pre-paste) for 10 ticks, then the pty buffer
    // drains (text visible in box), then Claude starts working.
    const frames = [
      ...Array(10).fill(BOOT_PANE),
      STUCK_PANE,
      WORKING_PANE,
    ];
    const { io, actions } = scriptedIO(frames);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false, // pane unchanged 400ms after paste — the real failure signature
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(actions).toEqual(["enter"]); // one discrete Enter once the text rendered, no re-paste
  });

  test("cold boot slower than the old 2s loop budget still recovers", async () => {
    // 20 frozen ticks = 8s of boot; old loop gave up at 2s.
    const frames = [...Array(20).fill(BOOT_PANE), STUCK_PANE, WORKING_PANE];
    const { io, actions } = scriptedIO(frames);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(actions).toEqual(["enter"]);
  });

  test("does not re-paste while the pane is frozen (would double the message)", async () => {
    // Frozen for the whole deadline: no evidence, so no destructive action.
    const { io, actions } = scriptedIO([BOOT_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
      deadlineMs: 4000,
    });
    expect(res.outcome).toBe("timeout");
    expect(actions).toEqual([]);
  });

  test("warm session: activity on first check exits immediately", async () => {
    const { io, actions } = scriptedIO([WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(actions).toEqual([]);
  });

  test("stuck input keeps getting discrete Enters until it submits", async () => {
    // Text renders but the first two Enters don't take (still mid-boot).
    const frames = [STUCK_PANE, STUCK_PANE, STUCK_PANE, WORKING_PANE];
    const { io, actions } = scriptedIO(frames);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(actions).toEqual(["enter", "enter", "enter"]);
  });

  test("genuinely dropped paste on a live pane re-pastes once after a grace period", async () => {
    // Pane is alive (differs from prePaste — spinnerless idle box) but our
    // text never appears anywhere.
    const LIVE_EMPTY = BOOT_PANE.replace("Claude Max", "Claude Max ");
    const frames = [...Array(8).fill(LIVE_EMPTY), STUCK_PANE, WORKING_PANE];
    const { io, actions } = scriptedIO(frames);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(res.rePasted).toBe(true);
    expect(actions[0]).toBe("repaste"); // after 3 consecutive live-empty observations
    expect(actions[actions.length - 1]).toBe("enter");
  });

  test("agent exited: reports exited so the caller can throw SESSION_EXITED", async () => {
    const { io } = scriptedIO([EXITED_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("exited");
  });

  test("text visible in transcript (not input box) counts as submitted", async () => {
    const TRANSCRIPT_PANE = `
> settings ui looks like crap - also it is slow also its broken

────────────────────────────────────────
❯
────────────────────────────────────────
`;
    const { io, actions } = scriptedIO([TRANSCRIPT_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("submitted");
    expect(actions).toEqual([]);
  });

  // Mid-turn inject: a follow-up pasted while the agent is still generating lands
  // in Claude Code's native type-ahead queue — rendered as a `❯ <text>` line above
  // the live composer with "↓ to manage" in the footer — and submits when the turn
  // ends. The verifier must read that queued line as proof-of-submit and ack
  // WITHOUT pressing Enter or re-pasting. Re-pasting a busy pane is precisely the
  // "paste storm" that once justified waiting for idle (now removed: ensureTmuxReady
  // reports busy and the caller injects straight into the queue). Panes captured
  // live from Claude Code 2.1.181; verified end-to-end (the queued message ran and
  // printed its marker once the turn finished).
  const QUEUED_PROMPT = "QUEUED_FOLLOWUP: after the sleep, print the words BANANA_PHONE";

  const BUSY_BEFORE_QUEUE_PANE = `
⏺ I started the command in the background. It will take ~40 seconds.

✻ Brewed for 14s · 1 shell still running
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt
`;

  const BUSY_WITH_QUEUED_MSG_PANE = `
⏺ I started the command in the background. It will take ~40 seconds.

✻ Brewed for 14s · 1 shell still running

❯ QUEUED_FOLLOWUP: after the sleep, print the words BANANA_PHONE

· Baking…
  ⎿  Tip: Use /permissions to pre-approve bash, edit, and MCP tools
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ↓ to manage
`;

  test("busy pane: pasted follow-up queues natively and acks without a paste storm", async () => {
    const { io, actions } = scriptedIO([BUSY_WITH_QUEUED_MSG_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BUSY_BEFORE_QUEUE_PANE,
      pasteConfirmed: true,
      contentPrefix: QUEUED_PROMPT.slice(0, 40),
    });
    expect(res.outcome).toBe("submitted");
    expect(res.rePasted).toBe(false);
    expect(actions).toEqual([]); // no Enter into the live box, no re-paste into a busy pane
  });
});
