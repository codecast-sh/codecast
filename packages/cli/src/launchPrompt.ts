// A session's first message, carried as the client's launch prompt argument.
//
// The daemon's only way to put text in a running Claude composer is a
// bracketed paste, and Claude Code wraps a paste in <pasted_content> and tells
// the model to follow instructions inside it only when the user's own message
// asks. A spawned worker's whole first turn is that paste, so it could read
// its brief as third party text and wait to be told to start (ct-55890). The
// launch argument (`claude [options] -- "<prompt>"`) is the user's own first
// message with no paste involved, so a session that starts with a message
// waiting takes it there instead.
//
// Pure helpers plus one file write: the daemon owns the start and the delivery.

import { isPollResponsePayload } from "@codecast/shared/contracts";
import * as fs from "node:fs";
import * as path from "node:path";
import { PendingDeliveryHeldError } from "./pendingDeliveryAdmission.js";
import { prepareInjectedContent } from "./tmuxPaste.js";

const PROMPT_PATH_RE = /^[A-Za-z0-9_./-]+$/;

/** Write `text` to a 0600 file and return the shell word that reads it back,
 *  so text of any shape rides a command line typed into a shell: nothing in it
 *  is parsed by the shell, and it never shows in the typed line. `once` has the
 *  shell remove the file as it reads it, for text only one launch will want. */
export function promptFileShellWord(dir: string, key: string, text: string, opts: { once?: boolean } = {}): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
  if (!PROMPT_PATH_RE.test(file)) throw new Error(`prompt path is not shell-safe: ${file}`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return opts.once ? `"$(cat ${file}; rm -f ${file})"` : `"$(cat ${file})"`;
}

/** Thrown by delivery's admission when the session's launch command already
 *  carries the message. A held delivery by type, so every injection path lets
 *  it through untouched; deliverMessage turns it into the launch's own verdict. */
export class LaunchPromptCarriedError extends PendingDeliveryHeldError {}

// One argv entry, well under the kernel's limit for argv plus environment.
const LAUNCH_PROMPT_MAX_BYTES = 128 * 1024;

export interface LaunchPromptRow {
  _id: string;
  conversation_id: string;
  content: string;
  created_at?: number;
  image_storage_ids?: string[];
  image_storage_id?: string;
}

/** The message a starting session takes as its launch argument: the oldest one
 *  waiting for the conversation, since that is the one delivery would paste
 *  first. Null when it has to go through the composer after all. */
export function pickLaunchPrompt<T extends LaunchPromptRow>(rows: readonly T[], conversationId: string): { row: T; text: string } | null {
  const first = rows
    .filter((r) => r.conversation_id === conversationId)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))[0];
  if (!first) return null;
  const text = launchPromptText(first);
  return text === null ? null : { row: first, text };
}

/** The text to launch with, or null for a message only the composer can take:
 *  an image rides a downloaded file path, a poll answer is keystrokes, and a
 *  leading `/` or `!` is a composer mode rather than a prompt. */
export function launchPromptText(row: Pick<LaunchPromptRow, "content" | "image_storage_ids" | "image_storage_id">): string | null {
  if (row.image_storage_ids?.length || row.image_storage_id) return null;
  const text = prepareInjectedContent(row.content ?? "", { bracketed: true });
  const head = text.trimStart();
  if (!head || /^[/!]/.test(head) || text.includes("\0")) return null;
  if (isPollResponsePayload(text)) return null;
  if (Buffer.byteLength(text, "utf8") > LAUNCH_PROMPT_MAX_BYTES) return null;
  return text;
}

/** The launch command's tail. `--` ends the options, so a variadic flag before
 *  it (a definition's --disallowedTools) cannot swallow the prompt and a prompt
 *  starting with `-` is never read as a flag. */
export function launchPromptFragment(dir: string, key: string, text: string): string {
  return ` -- ${promptFileShellWord(dir, key, text, { once: true })}`;
}

/** Whether a Claude transcript holds a prompt the user submitted, which for a
 *  session launched with a prompt argument is that argument. Rows the client
 *  writes before the first prompt (hook output, mode stamps) do not count, and
 *  neither does a tool result, which is also a user-role row. */
export function transcriptHasUserPrompt(jsonl: string): boolean {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const row = JSON.parse(line);
      if (row?.type !== "user" || row.isMeta) continue;
      const content = row.message?.content;
      if (typeof content === "string" ? content.trim() : Array.isArray(content) && content.some((b: any) => b?.type === "text")) return true;
    } catch {}
  }
  return false;
}
