// Typing message text into an agent's composer through tmux.
//
// Shared by the two delivery paths that do this: the daemon's injectViaTmux and
// the `cast claude` wrapper's own polling loop. Both used to hand tmux the raw
// message, which silently mangled anything multi-line — hence one home for the
// rules.
//
// The core constraint: in a terminal a newline byte is indistinguishable from
// the Enter key unless the payload is wrapped in bracketed-paste markers
// (ESC[200~ … ESC[201~). Inside those markers a TUI composer inserts a literal
// newline; outside them the same byte submits, so an unbracketed multi-line
// prompt is delivered as one message per line — each fragment answered
// separately, the tail lines arriving as interruptions.

import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";

/** Runs `tmux <args>`. Injected so callers keep their own timeouts and env. */
export type TmuxExec = (args: string[]) => Promise<unknown>;

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/**
 * Whether the client running in the pane turns on bracketed paste mode. tmux
 * only emits the markers when the foreground program asked for the mode, so an
 * unverified client must be flattened: pasting newlines it doesn't bracket
 * submits a message per line. Unknown/absent type means claude, the daemon's
 * default everywhere else.
 */
export function clientAcceptsBracketedPaste(agentType?: AgentClientId): boolean {
  return AGENT_CLIENTS[agentType ?? "claude"].capabilities.bracketedPaste === true;
}

/**
 * Shape message text for injection: keep newlines when the transport will
 * bracket the payload, flatten them to spaces when it won't (a mangled-but-whole
 * prompt beats N truncated ones). Trailing newlines always go — the discrete
 * Enter the callers send afterwards is what submits, and a trailing blank
 * composer line would swallow it. Idempotent, so preparing twice is harmless.
 */
export function prepareInjectedContent(content: string, opts: { bracketed: boolean }): string {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const shaped = opts.bracketed ? normalized : normalized.replace(/\n/g, " ");
  // Never return empty: an empty paste leaves the composer untouched and the
  // trailing Enter would submit whatever the user had typed there.
  return shaped || " ";
}

/**
 * Paste text into a pane via a tmux buffer — no per-char typing, so a leading
 * slash never opens the TUI's slash-command autocomplete. `-p` asks tmux for the
 * bracketed-paste markers, which it emits only when the pane's program has the
 * mode on; `bracketed` must reflect that same client capability so text destined
 * for a TUI that won't bracket it is flattened rather than split per line. The
 * send-keys fallback is raw keystrokes with no bracketing either way.
 */
export async function pasteTextIntoPane(
  exec: TmuxExec,
  target: string,
  text: string,
  bracketed = true,
): Promise<void> {
  const payload = prepareInjectedContent(text, { bracketed });
  const id = `cc-${process.pid}-${Date.now()}`;
  const tmpFile = `/tmp/${id}`;
  const fs = await import("node:fs");
  try {
    fs.writeFileSync(tmpFile, payload);
    await exec(["load-buffer", "-b", id, tmpFile]);
    await exec(["paste-buffer", "-p", "-t", target, "-b", id, "-d"]);
  } catch {
    await exec(["send-keys", "-t", target, "-l", prepareInjectedContent(payload, { bracketed: false })]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
