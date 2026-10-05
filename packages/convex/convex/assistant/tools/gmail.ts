// Gmail as a Mailbox (mail.ts) for the hosted assistant (plan pl-840): the
// mail tools' verbs over Gmail's REST API with the owner's token (google.ts).
// Everything Gmail-specific lives here: message shapes and MIME, threading
// headers, label ids, scopes and how many reads Gmail takes at once. The
// tools themselves, and the rules for which call asks the person, are in
// mail.ts and do not change when mail moves to another engine (Whisk,
// ct-57102).
import type { Tool } from "@platform/agent";
import { mapLimit } from "@codecast/shared/async";
import { decodeBase64, encodeBase64 } from "@codecast/shared/encryption";
import { htmlToText } from "../../lib/linkPreviewMeta";
import { GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, type GoogleCapabilities } from "../../googleOAuth";
import { googleCall, type GoogleDeps } from "./google";
import {
  bareAddress,
  mailTools,
  ONE_ADDRESS,
  oneLine,
  splitAddresses,
  type Mailbox,
  type MailMessage,
  type MailThread,
  type OutgoingMail,
  type ReplyEnvelope,
} from "./mail";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** How many of a search's threads are read at once. Gmail refuses a user's
 *  requests past a few in flight ("Too many concurrent requests for user"). */
export const SEARCH_READS_IN_FLIGHT = 5;

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };
type GmailThread = { id: string; messages?: GmailMessage[] };

export function header(part: Part | undefined, name: string): string {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

function decodePart(part: Part): string {
  if (!part.body?.data) return "";
  const charset = /charset="?([^";\s]+)/i.exec(header(part, "Content-Type"))?.[1] ?? "utf-8";
  const bytes = decodeBase64(part.body.data, "base64url");
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** A message's readable text: its plain part when it has one, else its HTML
 *  part as text. Attachments are named, never read. */
export function messageText(payload: Part | undefined): { text: string; attachments: string[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    if (part.filename) {
      attachments.push(part.filename);
      return;
    }
    const type = (part.mimeType ?? "").toLowerCase();
    if (type === "text/plain") plain.push(decodePart(part));
    else if (type === "text/html") html.push(decodePart(part));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  const text = plain.join("\n").trim() || htmlToText(html.join("\n"));
  return { text: text.replace(/\r\n/g, "\n"), attachments };
}

/** Gmail returns drafts inside a thread. */
const isDraft = (m: GmailMessage) => m.labelIds?.includes("DRAFT") ?? false;

const dateOf = (m: GmailMessage) => (m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ") : "");

/** A Gmail message as the mail tools show it; `full` adds its text. */
function toMailMessage(m: GmailMessage, full: boolean): MailMessage {
  const p = m.payload;
  return {
    id: m.id,
    from: header(p, "From"),
    to: header(p, "To"),
    cc: header(p, "Cc"),
    date: header(p, "Date"),
    at: dateOf(m),
    subject: header(p, "Subject"),
    snippet: m.snippet ?? "",
    draft: isDraft(m),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    ...(full ? messageText(p) : {}),
  };
}

const toMailThread = (t: GmailThread, full: boolean): MailThread => ({ id: t.id, messages: (t.messages ?? []).map((m) => toMailMessage(m, full)) });

// ── Building a message ──────────────────────────────────────────────────────

/** A header value, RFC 2047 encoded when it is not plain ASCII. */
export function encodeHeader(value: string): string {
  const line = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(line)) return line;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(line))}?=`;
}

/** Addresses as a header list, each checked to be exactly one address. */
export function addressHeader(addresses: readonly string[]): string {
  const clean = addresses.map(oneLine).filter(Boolean);
  for (const address of clean) {
    if (!ONE_ADDRESS.test(address)) throw new Error(`"${address}" is not one email address`);
  }
  return clean.join(", ");
}

/** The message as Gmail's `raw`: RFC 5322, UTF-8 body in base64, base64url overall. */
export function buildRawMessage(mail: OutgoingMail): string {
  if (mail.to.length === 0) throw new Error("A message needs at least one recipient");
  const body = encodeBase64(new TextEncoder().encode(mail.body.replace(/\r?\n/g, "\r\n"))).replace(/.{76}/g, "$&\r\n");
  const headers = [
    `To: ${addressHeader(mail.to)}`,
    ...(mail.cc?.length ? [`Cc: ${addressHeader(mail.cc)}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${oneLine(mail.inReplyTo)}`] : []),
    ...(mail.references ? [`References: ${oneLine(mail.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return encodeBase64(new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${body}`), "base64url");
}

/** Who a reply goes to and the headers that thread it, from the thread's
 *  last real message. Drafts are skipped: Gmail returns them in a thread, and
 *  a reply answers what was sent, never an unsent draft (the assistant's own
 *  earlier one, say). `me` is the person's own address, kept off a reply-all. */
export function replyEnvelope(thread: GmailThread, replyAll: boolean, me?: string): ReplyEnvelope {
  const sent = (thread.messages ?? []).filter((m) => !isDraft(m));
  const last = sent[sent.length - 1];
  if (!last) throw new Error("That thread has no sent messages to reply to");
  const p = last.payload;
  // A thread that ends with the person's own message continues to whoever it went to.
  const fromMe = last.labelIds?.includes("SENT") ?? false;
  const self = new Set([me, fromMe ? header(p, "From") : undefined].filter(Boolean).map((a) => bareAddress(a!)));
  const to = splitAddresses(fromMe ? header(p, "To") : header(p, "Reply-To") || header(p, "From"));
  const taken = new Set([...to.map(bareAddress), ...self]);
  const cc: string[] = [];
  if (replyAll) {
    for (const address of [...(fromMe ? [] : splitAddresses(header(p, "To"))), ...splitAddresses(header(p, "Cc"))]) {
      if (taken.has(bareAddress(address))) continue;
      taken.add(bareAddress(address));
      cc.push(address);
    }
  }
  const subject = header(sent[0].payload, "Subject") || header(p, "Subject");
  const messageId = header(p, "Message-ID");
  const references = [header(p, "References"), messageId].filter(Boolean).join(" ");
  return {
    to,
    ...(cc.length ? { cc } : {}),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    ...(messageId ? { inReplyTo: messageId } : {}),
    ...(references ? { references } : {}),
  };
}

const THREADING_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"];

// ── Labels ──────────────────────────────────────────────────────────────────

type GmailLabel = { id: string; name: string; type?: string };

/** Label ids for the names to add and remove, matched without case. Every
 *  name is checked against one read of the label list before anything is
 *  created, so an unknown label to remove fails the call with nothing changed;
 *  then a missing label to add is made. */
async function resolveLabels(deps: GoogleDeps, add: readonly string[], remove: readonly string[], signal?: AbortSignal): Promise<{ addLabelIds: string[]; removeLabelIds: string[] }> {
  const { labels = [] } = await googleCall<{ labels?: GmailLabel[] }>(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/labels`, {}, signal);
  const find = (name: string) => labels.find((l) => l.name.toLowerCase() === name.trim().toLowerCase() || l.id === name.trim());
  const removeLabelIds = remove.map((name) => {
    const found = find(name);
    if (!found) throw new Error(`No label named "${name}"`);
    return found.id;
  });
  const addLabelIds: string[] = [];
  for (const name of add) {
    let found = find(name);
    if (!found) {
      found = await googleCall<GmailLabel>(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/labels`, { method: "POST", body: { name: name.trim() } }, signal);
      labels.push(found);
    }
    addLabelIds.push(found.id);
  }
  return { addLabelIds, removeLabelIds };
}

async function modifyThreads(deps: GoogleDeps, threadIds: readonly string[], change: { addLabelIds?: string[]; removeLabelIds?: string[] }, signal?: AbortSignal) {
  for (const id of threadIds) {
    await googleCall(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/threads/${encodeURIComponent(id)}/modify`, { method: "POST", body: change }, signal);
  }
}

// ── The Mailbox ─────────────────────────────────────────────────────────────

const threadUrl = (id: string) => `${GMAIL_API}/threads/${encodeURIComponent(id)}`;

/** The owner's Gmail as a Mailbox. Nothing is called until a verb runs. */
export function gmailMailbox(deps: GoogleDeps): Mailbox {
  return {
    async search(query, max, signal) {
      const listed = await googleCall<{ threads?: { id: string }[] }>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/threads`, {
        query: { q: query, maxResults: max },
      }, signal);
      const ids = (listed?.threads ?? []).map((t) => t.id);
      // A thread can fail on its own (deleted since the list, or refused for
      // load): the search keeps the rest and counts what it skipped.
      const reads = await mapLimit(ids, SEARCH_READS_IN_FLIGHT, (id) =>
        googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, threadUrl(id), {
          query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
        }, signal).then((thread) => ({ thread }), (error: unknown) => ({ error })));
      const threads = reads.flatMap((r) => ("thread" in r ? [toMailThread(r.thread, false)] : []));
      const failed = reads.flatMap((r) => ("error" in r ? [r.error] : []));
      // Every read failing, or a stopped run, is the search failing.
      if (failed.length && (threads.length === 0 || signal?.aborted)) throw failed[0];
      return { threads, skipped: failed.length };
    },

    async thread(id, signal) {
      return toMailThread(await googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, threadUrl(id), { query: { format: "full" } }, signal), true);
    },

    async replyEnvelope(threadId, replyAll, signal) {
      const me = replyAll ? (await googleCall<{ emailAddress?: string }>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/profile`, {}, signal)).emailAddress : undefined;
      const thread = await googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, threadUrl(threadId), {
        query: { format: "metadata", metadataHeaders: THREADING_HEADERS },
      }, signal);
      return replyEnvelope(thread, replyAll, me);
    },

    async saveDraft(mail, signal) {
      const message = { raw: buildRawMessage(mail), ...(mail.threadId ? { threadId: mail.threadId } : {}) };
      const draft = await googleCall<{ id: string }>(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/drafts`, { method: "POST", body: { message } }, signal);
      return { draftId: draft.id };
    },

    async send(mail, signal) {
      const sent = await googleCall<{ id: string; threadId: string }>(deps, GMAIL_SEND_SCOPE, `${GMAIL_API}/messages/send`, {
        method: "POST",
        body: { raw: buildRawMessage(mail), ...(mail.threadId ? { threadId: mail.threadId } : {}) },
      }, signal);
      return { messageId: sent.id, threadId: sent.threadId };
    },

    async archive(threadIds, signal) {
      await modifyThreads(deps, threadIds, { removeLabelIds: ["INBOX"] }, signal);
    },

    async label(threadIds, add, remove, signal) {
      await modifyThreads(deps, threadIds, await resolveLabels(deps, add, remove, signal), signal);
    },
  };
}

/** The mail tools over the owner's Gmail, as far as the connection's grants allow. */
export function gmailTools(deps: GoogleDeps, can: Pick<GoogleCapabilities, "read_mail" | "modify_mail" | "send_mail">): Tool[] {
  return mailTools(gmailMailbox(deps), can);
}
