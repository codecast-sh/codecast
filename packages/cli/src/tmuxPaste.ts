// Typing message text into an agent's composer through tmux.
//
// Shared by the daemon's injection path and the `cast claude` wrapper. In a
// terminal, an unbracketed newline is the Enter key; preserving it would split a
// multiline prompt into multiple submissions. Verified clients receive a
// bracketed paste, while unverified clients receive one flattened prompt.

import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/** Runs `tmux <args>`. Injected so callers retain their own timeout/env policy. */
export type TmuxExec = (args: string[]) => Promise<unknown>;

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export interface PasteAndSubmitIO {
  paste: () => Promise<unknown>;
  submit: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<unknown>;
}

/**
 * Whether the client running in the pane enables bracketed-paste mode. Unknown
 * or absent type means Claude, matching the daemon's historical default.
 */
export function clientAcceptsBracketedPaste(agentType?: AgentClientId): boolean {
  return AGENT_CLIENTS[agentType ?? "claude"].capabilities.bracketedPaste === true;
}

/**
 * Shape message text for terminal injection. Line endings are normalized,
 * trailing newlines are removed so the caller's discrete Enter submits, and
 * unbracketed transports flatten internal newlines to keep the prompt whole.
 */
export function prepareInjectedContent(content: string, opts: { bracketed: boolean }): string {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const shaped = opts.bracketed ? normalized : normalized.replace(/\n/g, " ");
  // An empty paste would leave an existing draft untouched; the following Enter
  // could then submit that draft. A single space safely makes the paste explicit.
  return shaped || " ";
}

/**
 * Direct terminal APIs paste message text and submit it as two distinct actions.
 * Keeping this sequence in one helper prevents newline shaping from accidentally
 * removing the only submit byte, while ensuring callers send exactly one Enter.
 */
export async function pasteAndSubmitText(
  io: PasteAndSubmitIO,
  delayMs = 150,
): Promise<void> {
  await io.paste();
  await (io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
  await io.submit();
}

/**
 * Paste text through a temporary tmux buffer. `-p` asks tmux to bracket the
 * payload when the foreground application enabled that mode. If buffer-based
 * paste fails, raw `send-keys -l` is still safe because its fallback payload is
 * flattened first.
 */
export async function pasteTextIntoPane(
  exec: TmuxExec,
  target: string,
  text: string,
  bracketed = true,
): Promise<void> {
  const payload = prepareInjectedContent(text, { bracketed });
  const id = `cc-${process.pid}-${randomUUID()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-paste-"));
  const tmpFile = path.join(tmpDir, "payload");
  let bufferLoaded = false;
  try {
    fs.writeFileSync(tmpFile, payload, { flag: "wx", mode: 0o600 });
    await exec(["load-buffer", "-b", id, tmpFile]);
    bufferLoaded = true;
    await exec(["paste-buffer", "-p", "-t", target, "-b", id, "-d"]);
  } catch {
    await exec([
      "send-keys",
      "-t",
      target,
      "-l",
      prepareInjectedContent(payload, { bracketed: false }),
    ]);
  } finally {
    // `paste-buffer -d` removes the buffer on success. If paste itself fails,
    // however, tmux retains the named buffer (and its potentially sensitive
    // prompt text), so explicitly delete every buffer we successfully loaded.
    if (bufferLoaded) {
      try {
        await exec(["delete-buffer", "-b", id]);
      } catch {}
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}
