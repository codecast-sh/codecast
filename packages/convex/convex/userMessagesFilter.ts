// Pure filter/map logic for getUserMessages.
//
// Split out so we can unit-test the user-message filter without standing up a
// Convex ctx. The query handler in conversations.ts owns the auth + index
// query and then hands the user-message array here.
//
// IMPORTANT: this is user-prompt navigation data (message browser, rewind/fork
// navigator). It is user-only by construction — assistant messages must never
// be returned here. Keeping that invariant at the source means no client has to
// re-filter by role (a guard that has been silently dropped by refactors twice).

import { AGENT_SWITCH_NOTICE_PREFIX, MACHINE_SWITCH_NOTICE_PREFIX, MACHINE_MOVE_NOTICE_PREFIX, isAgentContextMessage, isTurnInterruptionNotice } from "@codecast/shared/contracts";

export type FilterableMessage = {
  _id: string;
  message_uuid?: string;
  from_user_id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  tool_calls?: Array<unknown> | null;
  tool_results?: Array<unknown> | null;
  subtype?: string;
  timestamp: number;
  images?: Array<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }>;
};

export type FilteredUserMessage = {
  _id: string;
  message_uuid?: string;
  from_user_id?: string;
  images?: Array<{ media_type: string; storage_id: string }>;
  role: "user";
  content: string;
  timestamp: number;
};

// Synthetic truncation notice the CLI injects into imported sessions for the
// model's context only. New CLIs never sync it; this hides rows older daemons
// already wrote (cleanup:deleteImportNoticeMessages drains them).
export const IMPORT_NOTICE_PREFIX = "[Codecast import]";

export function isImportNotice(content: string | null | undefined): boolean {
  return !!content && content.trimStart().startsWith(IMPORT_NOTICE_PREFIX);
}

const USER_NOISE_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "[Request interrupted",
  "[Request cancelled",
  IMPORT_NOTICE_PREFIX,
  AGENT_SWITCH_NOTICE_PREFIX,
  MACHINE_SWITCH_NOTICE_PREFIX,
  MACHINE_MOVE_NOTICE_PREFIX,
  "This session is being continued",
  "Your task is to create a detailed summary",
  "Please continue the conversation",
  "Read the output file to retrieve the result:",
  "Caveat:",
];

const SUMMARY_MARKER =
  "Your task is to create a detailed summary of the conversation so far";

// Navigator rows carry a snippet, not the body: the list only ever shows two
// lines per row, and a 2000-row subscription must stay small. A row whose
// content reaches this length may have been clipped; the hover card resolves
// the full body on demand (store page first, then `messages.webGet`).
export const NAV_ROW_SNIPPET_CHARS = 500;

export function stripContextTags(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .trim();
}

// Whether one message belongs in the navigator at all. Split out from the
// array pass so a STREAMING reader can judge each document as it arrives and
// keep only the narrow row — one predicate, both call shapes (see
// collectNavigableUserMessages).
export function isNavigableUserMessage(m: FilterableMessage): boolean {
  if (m.role !== "user") return false;
  if (m.subtype === "compact_boundary") return false;
  const hasImages = m.images?.some(image => !image.tool_use_id && image.storage_id);
  const t = stripContextTags(m.content ?? "");
  if (!t) return !!hasImages;
  if (isAgentContextMessage(t)) return false;
  if (isTurnInterruptionNotice(t)) return false;
  if (USER_NOISE_PREFIXES.some((p) => t.startsWith(p))) return false;
  if (t.includes(SUMMARY_MARKER)) return false;
  if (m.tool_results && m.tool_results.length > 0 && t.length < 5) return false;
  return true;
}

// The narrow row the navigator renders — two lines, never the body.
export function toNavigatorRow(m: FilterableMessage): FilteredUserMessage {
  return {
    _id: m._id,
    message_uuid: m.message_uuid,
    from_user_id: m.from_user_id,
    role: "user" as const,
    content: (stripContextTags(m.content ?? "") || (m.images?.length ? "Image attached" : "")).slice(0, NAV_ROW_SNIPPET_CHARS),
    ...(m.images?.some(image => !image.tool_use_id && image.storage_id) ? {
      images: m.images.filter(image => !image.tool_use_id && image.storage_id).map(image => ({ media_type: image.media_type, storage_id: image.storage_id! })),
    } : {}),
    timestamp: m.timestamp,
  };
}

// Roughly how much of the 1s user-JS budget one message document costs. That
// budget is spent on BYTES — deserializing the document and serializing the
// answer — so the scan stops on this, not on a document count alone. Measured
// from field lengths rather than JSON.stringify, which would itself cost the
// serialization the number exists to avoid.
export function approxMessageBytes(m: FilterableMessage): number {
  let n = (m.content?.length ?? 0) + 200;
  if (m.tool_results) for (const r of m.tool_results as Array<{ content?: string }>) n += r?.content?.length ?? 0;
  if (m.tool_calls) for (const c of m.tool_calls as Array<{ input?: string }>) n += c?.input?.length ?? 0;
  if (m.images) for (const i of m.images) n += i.data?.length ?? 0;
  return n;
}

export function filterUserMessages(
  userMsgs: FilterableMessage[],
): FilteredUserMessage[] {
  return userMsgs
    .filter(isNavigableUserMessage)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(toNavigatorRow);
}
