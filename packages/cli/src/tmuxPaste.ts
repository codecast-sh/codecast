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
 * The tmux key that enters a literal newline in this client's composer, for a
 * client that must be typed rather than pasted. Null for every other client.
 */
export function composerNewlineKey(agentType?: AgentClientId): string | null {
  return AGENT_CLIENTS[agentType ?? "claude"].typedComposerInput?.newlineKey ?? null;
}

// One `send-keys -l` per chunk of a line. A whole message would otherwise ride
// in a single argv, and a long one (a pasted diff, a quoted transcript) is the
// case that would hit the argv limit rather than the common short message.
const TYPED_CHUNK_CHARS = 1024;

/**
 * Type text into a pane key by key, with `newlineKey` between lines.
 *
 * Why: a bracketed paste is a paste GESTURE, and grok answers it by reading the
 * machine's clipboard and attaching any image on it — so a delivery carried a
 * screenshot the human had copied to xAI, under a message that never mentioned
 * it (ct-49607). Typed input never triggers that read; the newline key is what
 * keeps a multi-line message one message instead of one per line.
 */
export async function typeTextIntoPane(
  exec: TmuxExec,
  target: string,
  text: string,
  newlineKey: string,
): Promise<void> {
  const lines = prepareInjectedContent(text, { bracketed: true }).split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await exec(["send-keys", "-t", target, newlineKey]);
    for (let at = 0; at < line.length; at += TYPED_CHUNK_CHARS) {
      await exec(["send-keys", "-t", target, "-l", line.slice(at, at + TYPED_CHUNK_CHARS)]);
    }
  }
}

/**
 * Put message text in a pane's composer the way that client accepts it: typed
 * for a client whose composer reads the machine's clipboard on a paste, pasted
 * through a tmux buffer for everyone else. One entry point, so a caller never
 * has to know which clients those are.
 */
export async function deliverTextIntoPane(
  exec: TmuxExec,
  target: string,
  text: string,
  opts: { bracketed?: boolean; agentType?: AgentClientId } = {},
): Promise<void> {
  const newlineKey = composerNewlineKey(opts.agentType);
  if (newlineKey) return typeTextIntoPane(exec, target, text, newlineKey);
  return pasteTextIntoPane(exec, target, text, opts.bracketed ?? true);
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
