// Slash commands that open a panel in the agent's terminal: /mcp, /config,
// /agents, /model with no argument. The panel is the command having run. It
// starts no turn and writes nothing to the transcript until it closes, and it
// replaces the composer, so every check the delivery path makes after Enter
// reads it wrong: the payload never echoes (so the message looks undelivered)
// and the panel parses as a question for a human (so the paste guard holds the
// command and every message queued behind it). Alex Green sent /mcp from his
// phone on 2026-10-30, and his session sat 55 minutes on the open panel with
// "?" and "Update" queued behind it.
//
// So a panel that appears after a command's Enter counts as delivery, and the
// panel is remembered as ours: the person who sent the command from the app
// cannot reach it, and their next message means to talk to the agent, so the
// next delivery closes it with Escape (the key every one of these panels reads
// as cancel). Only the panel we opened is closed, and only while its question
// is still the one on screen; any other dialog keeps its hold.

import { canonicalSlashCommand } from "@codecast/shared/contracts";
import { parseInteractivePrompt } from "./interactivePrompt.js";

/** A one-line slash command: the only payload whose Enter may open a panel. */
export function mayOpenPanel(payload: string): boolean {
  return !payload.includes("\n") && canonicalSlashCommand(payload) !== null;
}

/** The question of the dialog drawn over the composer, null when there is none. */
export function paneDialogQuestion(pane: string): string | null {
  return parseInteractivePrompt(pane, true)?.question ?? null;
}

const openPanels = new Map<string, string>();

/** Our command opened this panel in the pane at `target`. */
export function rememberCommandPanel(target: string, question: string): void {
  openPanels.set(target, question);
}

type TmuxExec = (args: string[]) => Promise<{ stdout: string }>;

/**
 * Close the panel our own command left open in `target`, before a paste that
 * would otherwise be held behind it. Presses nothing unless that same panel is
 * still the dialog on screen. Returns whether it pressed Escape.
 */
export async function closeOwnCommandPanel(target: string, exec: TmuxExec, settleMs = 500): Promise<boolean> {
  const question = openPanels.get(target);
  if (question === undefined) return false;
  openPanels.delete(target);
  const { stdout } = await exec(["capture-pane", "-p", "-J", "-t", target, "-S", "-80"]);
  if (paneDialogQuestion(stdout) !== question) return false;
  await exec(["send-keys", "-t", target, "Escape"]);
  await new Promise(resolve => setTimeout(resolve, settleMs));
  return true;
}
