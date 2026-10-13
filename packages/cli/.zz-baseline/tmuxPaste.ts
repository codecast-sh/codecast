// Typing message text into an agent's composer through tmux.
//
// Shared by the daemon's injection path and the `cast claude` wrapper. In a
// terminal, an unbracketed newline is the Enter key; preserving it would split a
// multiline prompt into multiple submissions. Verified clients receive a
// bracketed paste, while unverified clients receive one flattened prompt.

import { AGENT_CLIENTS, type AgentClientId, localAgentClient } from "@codecast/shared/contracts";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { targetSession, withTmuxSession } from "./tmuxRoute.js";

/**
 * Literal text as the argument of `send-keys -l`.
 *
 * tmux's command parser ends a command at an argument whose last character is
 * an unescaped `;` and drops that character (cmd-parse.y,
 * cmd_parse_from_arguments): `send-keys -l 'abc;'` types `abc`, and a lone
 * `;` types nothing. The one escape it honours is a backslash right before
 * that final `;`, which the parser turns back into the semicolon, so text
 * ending in `;` goes out with a `\` inserted before it. Only the last
 * character is read this way; a `;` anywhere else is sent as typed.
 *
 * Why it matters: typed delivery writes a message in 128-character chunks, so
 * every chunk that happened to end on a `;` lost it. A trigger prompt typed
 * into jx7b88a on 2026-10-05 reached Claude six characters short, the
 * transcript never matched the payload the receipt was waiting for, and the
 * daemon wrote the same message five times over 100 minutes.
 */
export function tmuxLiteralArg(text: string): string {
  return text.endsWith(";") ? `${text.slice(0, -1)}\\;` : text;
}

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
 * The tmux key that enters a literal newline in this client's composer when
 * this text should be typed, or null when it should be pasted.
 *
 * A client that must be typed always is. An `idleOnly` client is typed only at
 * an idle composer, and only text typing carries whole: Claude's composer drops
 * a typed tab, and a lone character is the one write a dialog could take as
 * its answer, so both of those still paste.
 */
export function typedNewlineKey(agentType: AgentClientId | undefined, text: string, idle: boolean): string | null {
  const typed = localAgentClient(agentType ?? "claude").typedComposerInput;
  if (!typed) return null;
  if (typed.idleOnly && (!idle || text.includes("\t") || text.trim().length < 2)) return null;
  return typed.newlineKey;
}

// One `send-keys -l` per chunk, small ones. Claude Code reads a single input
// burst of roughly 500 characters or more as a paste even without bracket
// markers, and wraps it in <pasted_content> like any other (2.1.289: 450 typed
// clean, 512 wrapped).
const TYPED_CHUNK_CHARS = 128;

// Small chunks alone do not keep reads small. A client starved of CPU reads
// whatever piled up in the pty since its last read, so at load 240 an idle
// composer read the chunks of a 7 KB message as one burst, opened a paste that
// never closed, and took every later Enter as a newline: the message sat
// unsent while the session's queue grew behind it (jx76c85, 2026-10-05). So
// the next chunk waits until the pane shows the last one, which proves the
// client has read it. The wait is bounded; past it typing goes on as before.
const TYPED_ECHO_BUDGET_MS = 5_000;
const TYPED_ECHO_TAIL_CHARS = 24;

/** Text with whitespace and box-drawing frame glyphs removed, so a composer's
 *  soft wraps and borders never break a comparison with the payload. */
export const stripComposerChrome = (s: string) => s.replace(/[\s─-╿]+/g, "");

async function awaitTypedEcho(exec: TmuxExec, target: string, typedSoFar: string, budgetMs: number): Promise<void> {
  const tail = stripComposerChrome(typedSoFar).slice(-TYPED_ECHO_TAIL_CHARS);
  if (!tail) return;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const out = await exec(["capture-pane", "-p", "-J", "-t", target]) as { stdout?: string } | undefined;
      if (stripComposerChrome(out?.stdout ?? "").includes(tail)) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Newline keys whose byte can ride inside a literal chunk: tmux sends the "\n"
// in `send-keys -l` as the same 0x0a byte C-j sends, so a multi-line message
// goes in a few writes instead of one write per line.
const LITERAL_NEWLINE: Record<string, string> = { "C-j": "\n" };

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
  echoBudgetMs = TYPED_ECHO_BUDGET_MS,
): Promise<void> {
  const prepared = prepareInjectedContent(text, { bracketed: true });
  const literalNewline = LITERAL_NEWLINE[newlineKey];
  const lines = literalNewline === undefined ? prepared.split("\n") : [prepared.replace(/\n/g, literalNewline)];
  let typed = "";
  for (const [index, line] of lines.entries()) {
    if (index > 0) await exec(["send-keys", "-t", target, newlineKey]);
    for (let at = 0; at < line.length;) {
      // Never leave a lone character for the last write: that is the one write
      // a dialog could read as a keypress.
      const end = line.length - (at + TYPED_CHUNK_CHARS) === 1 ? at + TYPED_CHUNK_CHARS - 1 : at + TYPED_CHUNK_CHARS;
      if (typed) await awaitTypedEcho(exec, target, typed, echoBudgetMs);
      // `--` ends tmux's option parsing, so a chunk that starts with "-" is text.
      await exec(["send-keys", "-t", target, "-l", "--", tmuxLiteralArg(line.slice(at, end))]);
      typed += line.slice(at, end);
      at = end;
    }
    typed += "\n";
  }
}

// A typed write is paced by the pane's echo of the chunk before it, which
// took 0.33 s a chunk on 2026-10-05 (157 KB in 409 s, jx7b88a). One second a
// chunk is three times that; the 5 s echo budget is the ceiling under load.
export const TYPED_CHUNK_TIMEOUT_MS = 1_000;

/**
 * How long one delivery attempt of this text may run before the daemon
 * treats it as hung: the base covers a paste and its verification, and a
 * payload this client would type gets one allowance per chunk on top. A
 * flat budget timed out a 7 minute typed write at 3 minutes and started a
 * retry over the live attempt; the second copy then queued behind the first.
 */
export function deliveryTimeoutMsFor(text: string, agentType: AgentClientId | undefined, baseMs: number): number {
  const prepared = prepareInjectedContent(text, { bracketed: true });
  if (typedNewlineKey(agentType, prepared, true) === null) return baseMs;
  return baseMs + Math.ceil(prepared.length / TYPED_CHUNK_CHARS) * TYPED_CHUNK_TIMEOUT_MS;
}

/**
 * Put message text in a pane's composer the way that client accepts it: typed
 * when typedNewlineKey says so, pasted through a tmux buffer otherwise. One
 * entry point, so a caller never has to know which clients those are; `idle`
 * is the caller's word that the composer is idle with no dialog on screen.
 */
export async function deliverTextIntoPane(
  exec: TmuxExec,
  target: string,
  text: string,
  opts: { bracketed?: boolean; agentType?: AgentClientId; idle?: boolean; echoBudgetMs?: number } = {},
): Promise<void> {
  const newlineKey = typedNewlineKey(opts.agentType, text, opts.idle === true);
  if (newlineKey) return typeTextIntoPane(exec, target, text, newlineKey, opts.echoBudgetMs);
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
  // Buffers live on one tmux server, and load-buffer and delete-buffer name
  // no target to route by: outside the target session's scope they reached
  // the shared server while paste-buffer reached the session's own, and every
  // paste failed with "no buffer" (2026-10-07).
  const session = targetSession(target);
  if (session) return withTmuxSession(session, () => pasteThroughBuffer(exec, target, text, bracketed));
  return pasteThroughBuffer(exec, target, text, bracketed);
}

async function pasteThroughBuffer(exec: TmuxExec, target: string, text: string, bracketed: boolean): Promise<void> {
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
  } catch (error) {
    if (bufferLoaded) throw error;
    await exec([
      "send-keys",
      "-t",
      target,
      "-l",
      tmuxLiteralArg(prepareInjectedContent(payload, { bracketed: false })),
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
