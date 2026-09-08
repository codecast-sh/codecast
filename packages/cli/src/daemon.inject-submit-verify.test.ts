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
// recording every action the loop takes. `extra` adds the optional evidence
// sources — a pane with none of them is the shape every test below the matrix
// block was written against.
function scriptedIO(frames: string[], extra: Partial<TmuxSubmitVerifyIO> = {}) {
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
  return { io: { ...io, ...extra }, actions };
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
    expect(res.outcome).toBe("delivered");
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
    expect(res.outcome).toBe("delivered");
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
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(actions).toEqual([]);
  });

  test("warm session: activity on first check exits immediately", async () => {
    const { io, actions } = scriptedIO([WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
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
    expect(res.outcome).toBe("delivered");
    expect(actions).toEqual(["enter", "enter", "enter"]);
  });

  test("collapsed multiline paste gets a discrete Enter instead of being re-pasted", async () => {
    const PASTED_PANE = `
────────────────────────────────────────
❯ [Pasted text #1 +3 lines]
────────────────────────────────────────
  paste again to expand
`;
    const { io, actions } = scriptedIO([PASTED_PANE, WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: "first line that is hidden by the paste chip",
      multiline: true,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.rePasted).toBe(false);
    expect(actions).toEqual(["enter"]);
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
    expect(res.outcome).toBe("delivered");
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
    expect(res.outcome).toBe("delivered");
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
    expect(res.outcome).toBe("delivered");
    expect(res.rePasted).toBe(false);
    expect(actions).toEqual([]); // no Enter into the live box, no re-paste into a busy pane
  });

  // ct-40212: on a cold-boot pane whose paste was dropped, the pty-buffered
  // C-a/C-k clearing bytes submit as a garbage message and start a turn. That
  // turn's activity looks exactly like success, so the old loop acked the
  // delivery and the briefing was silently lost. Activity is only acceptable
  // evidence when the paste was confirmed or some trace of OUR payload was
  // seen; otherwise the loop must keep working the pane (re-paste, then honest
  // timeout for the caller to throw on).
  const GARBAGE_TURN_PANE = `
> 

⠹ Osmosing… (2s · ↓ 40 tokens)
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on · esc to interrupt
`;

  test("garbage turn: activity without any payload trace is not accepted; re-paste recovers", async () => {
    // 3 live ticks of a foreign turn (no payload anywhere) → one re-paste →
    // payload renders in the box → discrete Enter → activity now counts.
    const frames = [...Array(4).fill(GARBAGE_TURN_PANE), STUCK_PANE, WORKING_PANE];
    const { io, actions } = scriptedIO(frames);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.rePasted).toBe(true);
    expect(actions).toEqual(["repaste", "enter"]);
  });

  test("garbage turn with payload never appearing: honest timeout with payload flags for the caller's throw", async () => {
    const { io, actions } = scriptedIO([GARBAGE_TURN_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
      deadlineMs: 4000,
    });
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.payloadCheckable).toBe(true);
    expect(res.payloadSeen).toBe(false);
    expect(actions).toEqual(["repaste"]); // tried recovery once, never a blind ack
  });

  test("redelivery ambiguity (prefix already on screen pre-paste) keeps the legacy activity accept", async () => {
    // When the prefix was visible before the paste, its absence/presence proves
    // nothing — the loop must not hold deliveries hostage to an uncheckable
    // question, so plain activity still acks.
    const PRE_PASTE_WITH_PREFIX = WORKING_PANE; // transcript already shows the text
    const ACTIVE_PANE = WORKING_PANE.replace("· Osmosing… (3s", "⠋ thinking… (4s"); // live redraw with a real activity token
    const { io, actions } = scriptedIO([ACTIVE_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: PRE_PASTE_WITH_PREFIX,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.payloadCheckable).toBe(false);
    expect(actions).toEqual([]);
  });
});

// 2026-09-03: a resume's "continue" sat in the composer for good. The verify
// loop caught one frame without a prompt glyph (the TUI mid-redraw) and acked
// "submitted"; the daemon then reported "thinking" and the row went terminal.
// A single frame is thin evidence — the loop must look once more and, if the
// text is still at the prompt, press Enter instead of acking.
// ---------------------------------------------------------------------------
// Per-client submit evidence (the D0 matrix's CI half, ct-49536)
//
// Each pair below was captured from a live pane of that client (2026-09-06):
// the composer holding the pasted payload, then the same pane one Enter later
// with the turn running. The verifier has to read "submitted" from four
// different vocabularies — claude's spinner word, codex's "esc to interrupt"
// footer, grok's braille spinner and "[stop]" chrome, and opencode's pane with
// no prompt glyph at all — so a client whose chrome changes fails here without
// needing its binary on the runner.
// ---------------------------------------------------------------------------

const MATRIX_PAYLOAD = "matrix payload first line\nsecond line\n\nfourth after a blank line";

const CLIENT_FRAMES: Record<string, { idle: string; pasted: string; running: string; glyphless?: true }> = {
  claude: {
    idle: `
 ▐▛███▛█   Claude Code v2.1.263
  ▝▝ ▝▝    /private/tmp/matrix-claude
────────────────────────────────────────────────────────────────────────
❯ Try "how do I log an error?"
────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`,
    pasted: `
 ▐▛███▛█   Claude Code v2.1.263
  ▝▝ ▝▝    /private/tmp/matrix-claude
────────────────────────────────────────────────────────────────────────
❯ [Pasted text #1 +3 lines]
────────────────────────────────────────────────────────────────────────
  paste again to expand
`,
    running: `
 ▐▛███▛█   Claude Code v2.1.263
  ▝▝ ▝▝    /private/tmp/matrix-claude
❯ matrix payload first line
  second line
  fourth after a blank line
✽ Hashing…
                                                       ● high · /effort
────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────
  paste again to expand
`,
  },
  codex: {
    idle: `
╭─────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)              │
╰─────────────────────────────────────────╯
› Ask Codex to do anything
  ? for shortcuts
`,
    pasted: `
› matrix payload first line
  second line
  fourth after a blank line
  matrix default · /private/tmp/matrix-codex
`,
    running: `
› matrix payload first line
  second line
  fourth after a blank line
⚠ Model metadata for \`matrix\` not found. Defaulting to fallback metadata.
• Working (1s • esc to interrupt)
› Ask Codex to do anything
  matrix default · /private/tmp/matrix-codex
`,
  },
  grok: {
    idle: `
  /private/tmp/matrix-grok
  ╭────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                  │
  ╰──────────────────────────────── matrix · always-approve ───────────╯
  Shift+Tab:mode  │  Ctrl+x:shortcuts
`,
    pasted: `
  ╭────────────────────────────────────────────────────────────────────╮
  │ ❯ [Pasted: 4 lines]                                                │
  ╰──────────────────────────────── matrix · always-approve ───────────╯
  Enter:send  │  Shift+Tab:mode  │  Ctrl+x:shortcuts
`,
    running: `
  /private/tmp/matrix-grok                                    1.5K / 200K
     ❯ matrix payload first line                                 9:32 PM
       second line
        …
    ⠴ Waiting for response… 1.7s                    1.7s ⇣1.51k [stop]
  ╭────────────────────────────────────────────────────────────────────╮
  │ ❯                                                                  │
  ╰──────────────────────────────── matrix · always-approve ───────────╯
  Shift+Tab:mode  │  Esc:cancel  │  Ctrl+x:shortcuts
`,
  },
  opencode: {
    glyphless: true,
    idle: `
                    ┃
                    ┃  Ask anything… "Fix broken tests"
                    ┃
                    ┃  Build · matrix-model matrix
                                   tab agents  ctrl+p commands
  /private/tmp/matrix-opencode                          1.18.29
`,
    pasted: `
                    ┃
                    ┃  [Pasted ~4 lines]
                    ┃
                    ┃  Build · matrix-model matrix
                                   tab agents  ctrl+p commands
  /private/tmp/matrix-opencode                          1.18.29
`,
    running: `
  ┃  matrix payload first line
  ┃  second line
  ┃
  ┃  fourth after a blank line
     ▣  Build · matrix-model
  ┃  Build · matrix-model matrix
   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt              tab agents  ctrl+p commands
`,
  },
};

describe("verifyTmuxSubmitAfterPaste — real client turn-started frames", () => {
  for (const [client, frames] of Object.entries(CLIENT_FRAMES)) {
    test(`${client}: the running turn reads as submitted, with no extra keys`, async () => {
      const { io, actions } = scriptedIO([frames.running]);
      const result = await verifyTmuxSubmitAfterPaste(io, {
        prePaste: frames.idle,
        pasteConfirmed: true,
        contentPrefix: MATRIX_PAYLOAD.slice(0, 40),
        multiline: true,
        deadlineMs: 4_000,
      });
      expect(result.outcome).toBe("delivered");
      // The caller already sent the gate's Enter; a second one would submit
      // whatever the person at the keyboard typed next.
      expect(actions).toEqual([]);
    });

    test(`${client}: the payload still sitting in the composer is ${frames.glyphless ? "invisible to the pane verifier" : "answered with a discrete Enter"}`, async () => {
      const { io, actions } = scriptedIO([frames.pasted]);
      const result = await verifyTmuxSubmitAfterPaste(io, {
        prePaste: frames.idle,
        pasteConfirmed: true,
        contentPrefix: MATRIX_PAYLOAD.slice(0, 40),
        multiline: true,
        deadlineMs: 2_000,
      });
      if (frames.glyphless) {
        // opencode draws no prompt glyph, so "our text is still in the box"
        // and "the turn is running" are the same picture and the verifier acks.
        // That is why opencode's turn state comes from its SQLite store and not
        // from this loop — the pane cannot answer the question.
        expect(result.outcome).toBe("delivered");
        return;
      }
      // The chip (or the text) is still at the prompt: the Enter was swallowed
      // into the paste burst, so the loop presses a discrete one and keeps
      // watching rather than acking a message nobody submitted.
      expect(result.outcome).toBe("agent_prompt_stalled");
      expect(actions).toContain("enter");
    });
  }
});

describe("verifyTmuxSubmitAfterPaste — a lone frame is not a submit", () => {
  const REDRAW_BLANK_PANE = `
 ▐▛███▜▌   Claude Code v2.1.175
▝▜█████▛▘  Fable 5 with high effort · Claude Max


`;
  // Transcript above the box carries a word the activity regex matches
  // ("Read"), while the composer still holds our text.
  const STUCK_WITH_TRANSCRIPT_KEYWORD_PANE = `
⏺ Read the settings file and found nothing.
────────────────────────────────────────
❯ settings ui looks like crap - also it is slow also its broken
────────────────────────────────────────
  ⏵⏵ don't ask on (shift+tab to cycle)
`;

  test("a promptless redraw with the text still in the box gets a discrete Enter, not an ack", async () => {
    const { io, actions } = scriptedIO([REDRAW_BLANK_PANE, STUCK_PANE, STUCK_PANE, WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(actions).toEqual(["enter", "enter"]);
  });

  test("an activity-looking frame with the text still at the prompt gets a discrete Enter", async () => {
    const { io, actions } = scriptedIO([STUCK_WITH_TRANSCRIPT_KEYWORD_PANE, STUCK_WITH_TRANSCRIPT_KEYWORD_PANE, WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(actions[0]).toBe("enter");
  });

  test("the same holds when the prefix was already on screen (uncheckable payload)", async () => {
    const { io, actions } = scriptedIO([REDRAW_BLANK_PANE, STUCK_PANE, WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: STUCK_PANE, // transcript already showed the text before the paste
      pasteConfirmed: false,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.payloadCheckable).toBe(false);
    expect(actions).toEqual(["enter"]);
  });

  test("a genuine submit (box empty on the second look) still acks without extra keys", async () => {
    const { io, actions } = scriptedIO([REDRAW_BLANK_PANE, WORKING_PANE]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: BOOT_PANE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
    });
    expect(res.outcome).toBe("delivered");
    expect(actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two sources that do not read the pane (ct-49539)
//
// Every case above proves the submit from what tmux captured. That fails on a
// pane which says nothing the daemon recognises — a client whose spinner is not
// in the activity regex, one that redraws its composer empty and prints the
// turn nowhere. The daemon has two other witnesses for the same question: the
// status hook, which reports a working turn for the pane's session id, and the
// pane title, which several clients flip for exactly the length of a turn.
//
// Both are read against a "before" the CALLER captures with the pre-paste pane,
// never at the top of this loop: by then the Enter has gone in, and a client
// that flips its title within the tick would look like it had always been that
// way. The baseline tests below are what pin that.
// ---------------------------------------------------------------------------

// A pane with no opinion: composer empty again, no spinner glyph the daemon
// knows, our payload nowhere on screen.
const SILENT_PRE = `
  Build · matrix-model matrix
────────────────────────────────────────
❯
────────────────────────────────────────
  tab agents  ctrl+p commands
`;

// The same pane a moment later. Differs from SILENT_PRE only in the token
// counter, so the loop's frozen-pane check does not swallow it — but nothing in
// it says whether our message was submitted.
const SILENT_POST = `
  Build · matrix-model matrix                    1.5K / 200K
────────────────────────────────────────
❯
────────────────────────────────────────
  tab agents  ctrl+p commands
`;

const PASTE_AT = 10_000;

describe("verifyTmuxSubmitAfterPaste — hook and title evidence", () => {
  const silent = (extra: Partial<TmuxSubmitVerifyIO>) => scriptedIO([SILENT_POST], extra);

  test("the hook reporting a turn after the paste is a delivered submit", async () => {
    const { io, actions } = silent({ hookTurnStartedAt: async () => PASTE_AT + 1 });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.evidence).toBe("hook_working_turn");
    // The pane never proved anything, so without the hook this run would have
    // spent five blind Enters and then given up.
    expect(actions).toEqual([]);
  });

  test("a turn that started before the paste belongs to someone else", async () => {
    const { io, actions } = silent({ hookTurnStartedAt: async () => PASTE_AT - 1 });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.evidence).toBeNull();
    expect(actions).toEqual(["enter", "enter", "enter", "enter", "enter"]);
  });

  test("a title that starts spinning after the paste is a delivered submit", async () => {
    const { io, actions } = silent({ paneTitle: async () => "_ codex" });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      paneTitleBefore: "codex",
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("delivered");
    expect(res.evidence).toBe("pane_title");
    expect(actions).toEqual([]);
  });

  test("a title that already said working before the paste is not news about it", async () => {
    // claude writes "_ Claude Code" from boot and never moves it, so without the
    // pre-paste baseline this source would report every claude pane delivered.
    const { io, actions } = silent({ paneTitle: async () => "_ Claude Code" });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      paneTitleBefore: "_ Claude Code",
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.evidence).toBeNull();
    expect(actions).toEqual(["enter", "enter", "enter", "enter", "enter"]);
  });

  test("no source answers: five bounded Enters, then a stall the caller can see", async () => {
    const { io, actions } = silent({
      hookTurnStartedAt: async () => null,
      paneTitle: async () => "codex",
    });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      paneTitleBefore: "codex",
      deadlineMs: 4_000,
    });
    // Never "delivered": the presumed-status write reads this outcome, and a
    // stall painted as a running turn is what terminalized the row on
    // 2026-09-03 and left the healer nothing to revive.
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.evidence).toBeNull();
    expect(actions).toEqual(["enter", "enter", "enter", "enter", "enter"]);
  });

  test("the pane is asked first, so it names the evidence when it can answer", async () => {
    const SPINNER_POST = `
  Build · matrix-model matrix                    1.5K / 200K
⠙ Working (2s • esc to interrupt)
────────────────────────────────────────
❯
────────────────────────────────────────
`;
    const { io } = scriptedIO([SPINNER_POST], {
      hookTurnStartedAt: async () => PASTE_AT + 1,
      paneTitle: async () => "_ codex",
    });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      paneTitleBefore: "codex",
    });
    expect(res.outcome).toBe("delivered");
    // Cheapest first: the capture is already in hand, the turn mark is a map
    // read, and the title costs a tmux call nobody made here.
    expect(res.evidence).toBe("pane_activity");
  });

  test("a foreign turn is still possible, so the hook does not ack for it either", async () => {
    // The ct-40212 shape: unconfirmed paste, our payload never on screen, and a
    // turn running. The turn may be the buffered clearing bytes submitting as
    // garbage, and the hook cannot tell those apart — so it is held to the same
    // guard as the pane scrape.
    const { io, actions } = scriptedIO([SILENT_POST], {
      hookTurnStartedAt: async () => PASTE_AT + 1,
    });
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: false,
      contentPrefix: PROMPT,
      pasteAt: PASTE_AT,
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.evidence).toBeNull();
    expect(actions).toEqual(["repaste"]); // recovery, never a blind ack
  });
});

describe("verifyTmuxSubmitAfterPaste — a dialog took the keyboard", () => {
  const CODEX_PERMISSION = `
› run the migration
⠙ Working (2s • esc to interrupt)

  Would you like to run the following command?

    bunx convex deploy

  Press enter to confirm or esc to cancel
`;

  test("a permission dialog raised after the paste blocks, spinner or not", async () => {
    // The dialog check runs before every evidence source on purpose: codex keeps
    // its spinner drawn while the dialog waits, so a pane can look busy and hold
    // our prompt unsubmitted at the same time.
    const { io, actions } = scriptedIO([CODEX_PERMISSION]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SILENT_PRE,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("agent_prompt_blocked");
    expect(res.evidence).toBeNull();
    // Enter at a permission dialog is how a blind un-wedge once walked a credits
    // chooser to "Pay $45.00 now" (ct-38494).
    expect(actions).toEqual([]);
  });

  test("a dialog that predates the paste is not this submit's verdict, and nobody types at it", async () => {
    // Codex draws the spinner only while a turn runs, so a settled pane waiting
    // on an answer looks like this. The dialog was already there before the
    // paste — the pre-flight's business, not this submit's — so the loop must
    // neither report it as our block nor spend its bounded Enters on it.
    const SETTLED_DIALOG = CODEX_PERMISSION.replace("⠙ Working (2s • esc to interrupt)\n", "");
    const { io, actions } = scriptedIO([SETTLED_DIALOG + "\n"]);
    const res = await verifyTmuxSubmitAfterPaste(io, {
      prePaste: SETTLED_DIALOG,
      pasteConfirmed: true,
      contentPrefix: PROMPT,
      deadlineMs: 4_000,
    });
    expect(res.outcome).toBe("agent_prompt_stalled");
    expect(res.evidence).toBeNull();
    expect(actions).toEqual([]);
  });
});
