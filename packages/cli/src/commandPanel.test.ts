import { describe, expect, test } from "bun:test";
import { verifyTmuxSubmitAfterPaste, type TmuxSubmitVerifyIO } from "./daemon.js";
import { closeOwnCommandPanel, confirmModelSwitch, mayOpenPanel, modelSwitchConfirmKey, paneDialogQuestion, rememberCommandPanel } from "./commandPanel.js";

// Frames captured from Claude Code 2.1.318 in tmux. Alex Green sent /mcp from
// his phone (2026-10-30): the verifier read the panel's help line ("…/en/mcp")
// as the command still in the composer, pressed Enter into the panel, the paste
// guard refused that as a dialog waiting on a human, and the message and
// everything queued behind it was held for 55 minutes.

const IDLE = `
 ▐▛███▛█   Claude Code v2.1.318
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

const TYPED = `
  ❯ /mcp                               Manage MCP servers
    /built-in-browser                  Read this skill before the first step that uses the built-in browser
────────────────────────────────────────
❯ /mcp
────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

const MCP_PANEL = `
 ▐▛███▛█   Claude Code v2.1.318
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ tmux focus-events off
   Manage MCP servers
   3 servers
     User MCPs (/Users/dev/.claude.json)
   ❯ … electron
     Built-in MCPs (always available)
     ◯ computer-use
     ✔ plugin:paper-desktop:paper   41 tools
   https://code.claude.com/docs/en/mcp for help
   ↑/↓ to navigate · Enter to confirm · Esc to cancel
`;

function scriptedIO(frames: string[]) {
  const actions: string[] = [];
  let i = 0;
  const io: TmuxSubmitVerifyIO = {
    capture: async () => frames[Math.min(i++, frames.length - 1)],
    sendEnter: async () => { actions.push("enter"); },
    rePaste: async () => { actions.push("repaste"); },
    sleep: async () => {},
    log: () => {},
  };
  return { io, actions };
}

describe("a slash command that opens a panel", () => {
  test("is delivered once the panel is up, with no Enter pressed into it", async () => {
    const { io, actions } = scriptedIO([MCP_PANEL]);
    const result = await verifyTmuxSubmitAfterPaste(io, { prePaste: IDLE, pasteConfirmed: true, payloadObserved: true, contentPrefix: "/mcp", slashCommand: true });
    expect(result).toMatchObject({ outcome: "delivered", evidence: "command_panel" });
    expect(actions).toEqual([]);
  });

  test("a dialog that was already up before the paste proves nothing", async () => {
    const { io } = scriptedIO([MCP_PANEL]);
    const result = await verifyTmuxSubmitAfterPaste(io, { prePaste: MCP_PANEL, pasteConfirmed: true, contentPrefix: "/mcp", slashCommand: true, deadlineMs: 2_000 });
    expect(result.evidence).not.toBe("command_panel");
  });

  test("only a one-line slash command may open a panel; the autocomplete list is not one", () => {
    expect(mayOpenPanel("/mcp")).toBe(true);
    expect(mayOpenPanel("/model opus")).toBe(true);
    expect(mayOpenPanel("Update")).toBe(false);
    expect(mayOpenPanel("/mcp\nand more")).toBe(false);
    expect(paneDialogQuestion(TYPED)).toBeNull();
    expect(paneDialogQuestion(MCP_PANEL)).toBe("Manage MCP servers");
  });
});

describe("closeOwnCommandPanel", () => {
  const execOn = (pane: string) => {
    const sent: string[] = [];
    const exec = async (args: string[]) => {
      if (args[0] === "send-keys") sent.push(args.at(-1)!);
      return { stdout: pane };
    };
    return { exec, sent };
  };

  test("closes the panel our command opened, once", async () => {
    rememberCommandPanel("t:0.0", "Manage MCP servers");
    const { exec, sent } = execOn(MCP_PANEL);
    expect(await closeOwnCommandPanel("t:0.0", exec, 0)).toBe(true);
    expect(await closeOwnCommandPanel("t:0.0", exec, 0)).toBe(false);
    expect(sent).toEqual(["Escape"]);
  });

  test("leaves any other dialog to its hold", async () => {
    rememberCommandPanel("t:0.1", "Manage MCP servers");
    const question = MCP_PANEL.replace("Manage MCP servers", "Which tier should run first?");
    const { exec, sent } = execOn(question);
    expect(await closeOwnCommandPanel("t:0.1", exec, 0)).toBe(false);
    expect(await closeOwnCommandPanel("t:0.2", execOn(MCP_PANEL).exec, 0)).toBe(false);
    expect(sent).toEqual([]);
  });
});

// Captured from the LX lighting session's pane (Claude Code, 2026-11-22) right
// after `/model opus` on a Fable conversation with a warm cache. The next
// delivery's Escape chose "No, go back" every time, so the app's "Continue on
// Opus" kept the session on Fable.
const MODEL_SWITCH_CONFIRM = `
❯ continue
  ⎿  You've hit your Fable limit · resets Nov 25 at 11am (America/Los_Angeles)
     /usage-credits to finish what you’re working on.
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
  Switch model?
  Your next response will be slower and use more tokens

  This conversation is cached for the current model. Switching to Opus 5.5 means the full history gets re-read.

  ❯ 1. Yes, switch to Opus 5.5
    2. No, go back

  Enter to confirm · Esc to cancel
`;

const AFTER_SWITCH = `
❯ /model opus
  ⎿  Set model to Opus 5.5 and saved as your default for new sessions
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

describe("the confirmation /model <name> asks before switching", () => {
  test("is confirmed for a /model command that named the model", () => {
    expect(modelSwitchConfirmKey("/model opus", MODEL_SWITCH_CONFIRM)).toBe("1");
    expect(modelSwitchConfirmKey("/model  claude-opus-5-5", MODEL_SWITCH_CONFIRM)).toBe("1");
  });

  test("is left alone for any other command, and other dialogs are not it", () => {
    expect(modelSwitchConfirmKey("/model", MODEL_SWITCH_CONFIRM)).toBeNull();
    expect(modelSwitchConfirmKey("/mcp", MODEL_SWITCH_CONFIRM)).toBeNull();
    expect(modelSwitchConfirmKey("continue", MODEL_SWITCH_CONFIRM)).toBeNull();
    expect(modelSwitchConfirmKey("/model opus", MCP_PANEL)).toBeNull();
    expect(modelSwitchConfirmKey("/model opus", AFTER_SWITCH)).toBeNull();
  });

  test("presses Yes once and no Enter when the digit closed the dialog", async () => {
    const sent: string[] = [];
    const frames = [AFTER_SWITCH];
    const exec = async (args: string[]) => {
      if (args[0] === "send-keys") sent.push(args.at(-1)!);
      return { stdout: frames[0] };
    };
    expect(await confirmModelSwitch("t:1.0", "/model opus", MODEL_SWITCH_CONFIRM, exec, 0)).toBe(true);
    expect(sent).toEqual(["1"]);
  });

  test("follows the digit with Enter when the same dialog is still up", async () => {
    const sent: string[] = [];
    const exec = async (args: string[]) => {
      if (args[0] === "send-keys") sent.push(args.at(-1)!);
      return { stdout: MODEL_SWITCH_CONFIRM };
    };
    expect(await confirmModelSwitch("t:1.1", "/model opus", MODEL_SWITCH_CONFIRM, exec, 0)).toBe(true);
    expect(sent).toEqual(["1", "Enter"]);
  });

  test("is never remembered as a panel the next message closes", async () => {
    const sent: string[] = [];
    const exec = async (args: string[]) => {
      if (args[0] === "send-keys") sent.push(args.at(-1)!);
      return { stdout: AFTER_SWITCH };
    };
    await confirmModelSwitch("t:1.2", "/model opus", MODEL_SWITCH_CONFIRM, exec, 0);
    expect(await closeOwnCommandPanel("t:1.2", exec, 0)).toBe(false);
    expect(sent).not.toContain("Escape");
  });
});
