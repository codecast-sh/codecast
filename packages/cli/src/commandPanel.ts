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
//
// One dialog a command opens is not a panel: `/model <name>` on a conversation
// whose cache is warm asks "Switch model? … Switching to Opus 5.5 means the full
// history gets re-read", with "Yes, switch to Opus 5.5" and "No, go back". It
// asks the sender to confirm the switch they just typed by name, so delivery
// confirms it. Remembered as a panel, the next message's Escape chose "No, go
// back": the app's "Continue on Opus" sends /model opus and then continue, so
// the session printed "Kept model as Fable 5.2", hit the Fable limit again, and
// five presses later was still parked (jx72zdg, 2026-11-22).

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

/**
 * The key that confirms the switch a `/model <name>` command asks about, or
 * null when `payload` is not such a command or `pane` shows no such dialog.
 * A bare `/model` opens the model list, a real panel, and never matches.
 */
export function modelSwitchConfirmKey(payload: string, pane: string): string | null {
  const command = canonicalSlashCommand(payload);
  if (!command || !/^\/model \S/.test(command)) return null;
  const prompt = parseInteractivePrompt(pane, true);
  const idx = prompt?.options.findIndex(o => /^yes,? switch to\b/i.test(o.label.trim())) ?? -1;
  return idx < 0 ? null : String(idx + 1);
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

/**
 * Confirm the model switch the command in `payload` opened in `target`.
 * Presses the confirming option's number; when the same dialog is still up
 * after it (a menu where digits only move the highlight), presses Enter.
 * Returns whether it confirmed; presses nothing when no such dialog is up.
 */
export async function confirmModelSwitch(target: string, payload: string, pane: string, exec: TmuxExec, settleMs = 500): Promise<boolean> {
  const key = modelSwitchConfirmKey(payload, pane);
  if (key === null) return false;
  const question = paneDialogQuestion(pane);
  await exec(["send-keys", "-t", target, key]);
  await new Promise(resolve => setTimeout(resolve, settleMs));
  const { stdout } = await exec(["capture-pane", "-p", "-J", "-t", target, "-S", "-80"]);
  if (question !== null && paneDialogQuestion(stdout) === question) {
    await exec(["send-keys", "-t", target, "Enter"]);
    await new Promise(resolve => setTimeout(resolve, settleMs));
  }
  return true;
}
