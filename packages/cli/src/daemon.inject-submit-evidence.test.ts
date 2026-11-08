import { describe, expect, test } from "bun:test";
import { verifyTmuxSubmitAfterPaste, type TmuxSubmitVerifyIO } from "./daemon.js";
import { PROMPT, scriptedIO } from "./test-helpers/tmuxSubmitVerifyIO.js";

// The two sources that do not read the pane (ct-49539)
//
// Every case in daemon.inject-submit-verify.test.ts proves the submit from
// what tmux captured. That fails on a pane which says nothing the daemon recognises — a client whose spinner is not
// in the activity regex, one that redraws its composer empty and prints the
// turn nowhere. The daemon has two other witnesses for the same question: the
// status hook, which reports a working turn for the pane's session id, and the
// pane title, which several clients flip for exactly the length of a turn.
//
// Both are read against a "before" the CALLER captures with the pre-paste pane,
// never at the top of this loop: by then the Enter has gone in, and a client
// that flips its title within the tick would look like it had always been that
// way. The baseline tests below are what pin that.

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
    expect(actions).toEqual([]);
  });
});

test("a payload observed by the Enter gate can leave the composer before the verifier starts", async () => {
  const { io, actions } = scriptedIO(["────────────\n❯ \n────────────\nbypass permissions on"]);
  const result = await verifyTmuxSubmitAfterPaste(io, {
    prePaste: SILENT_PRE, pasteConfirmed: true, payloadObserved: true, contentPrefix: PROMPT, deadlineMs: 4000,
  });
  expect(result.outcome).toBe("delivered");
  expect(result.evidence).toBe("payload_gone");
  expect(actions).toEqual([]);
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
