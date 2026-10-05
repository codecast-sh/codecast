// The hosted assistant's Gmail tools (plan pl-840): search and read threads,
// save drafts, send, archive and label, over Gmail's REST API with the
// owner's token (google.ts). Reads and drafts are risk "read": a draft
// changes nothing anyone else sees. Sending, archiving and labelling are
// "write" and pass the gate.
//
// Mail is outside content. Every tool whose result carries text from a
// message declares source "mail", so the harness fences it as data.
import { defineTool, Type, UNTRUSTED_MAX_CHARS, untrustedBody, type Tool } from "@platform/agent";
import { mapLimit } from "@codecast/shared/async";
import { decodeBase64, encodeBase64 } from "@codecast/shared/encryption";
import { htmlToText } from "../../lib/linkPreviewMeta";
import { GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, type GoogleCapabilities } from "../../googleOAuth";
import { googleCall, type GoogleDeps } from "./google";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The most threads one search reads. */
export const SEARCH_MAX_THREADS = 25;
/** How many of a search's threads are read at once. Gmail refuses a user's
 *  requests past a few in flight ("Too many concurrent requests for user"). */
export const SEARCH_READS_IN_FLIGHT = 5;
/** How much of one message body a thread read returns. */
export const MESSAGE_BODY_MAX_CHARS = 8_000;
/** How much text one thread read returns in all: under the fence's own cap
 *  (UNTRUSTED_MAX_CHARS), which cuts a block's end and so would drop the
 *  newest messages. Anyone can lengthen a thread by replying to it, so the
 *  newest messages are kept whole, older ones shortened to sender, date and
 *  snippet, and the oldest left out once even those do not fit. Blocks are
 *  measured as the fence holds them (untrustedBody), since its escaping can
 *  make a message several times longer than its raw text. */
export const THREAD_MAX_CHARS = UNTRUSTED_MAX_CHARS - 1_000;

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

/** Gmail returns drafts inside a thread. A draft is unsent, often the
 *  assistant's own, so it never stands for the thread's latest word. */
const isDraft = (m: GmailMessage) => m.labelIds?.includes("DRAFT") ?? false;

const dateOf = (m: GmailMessage) => (m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 16).replace("T", " ") : "");

// ── Building a message ──────────────────────────────────────────────────────

/** A header value on one line: a line break in a value would start a header of its own. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** A header value, RFC 2047 encoded when it is not plain ASCII. */
export function encodeHeader(value: string): string {
  const line = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(line)) return line;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(line))}?=`;
}

const ADDR = "[^<>@\\s,;\"]+@[^<>@\\s,;\"]+";
/** One recipient: a bare address, or a display name and an address in angle
 *  brackets. An unquoted name may not hold ',', ';', '@' or a quote, so one
 *  entry can never stand for two recipients. */
const ONE_ADDRESS = new RegExp(`^(?:${ADDR}|(?:"[^"\\\\]*"|[^<>@,;"]*)\\s*<${ADDR}>)$`);

/** Addresses as a header list, each checked to be exactly one address. */
export function addressHeader(addresses: readonly string[]): string {
  const clean = addresses.map(oneLine).filter(Boolean);
  for (const address of clean) {
    if (!ONE_ADDRESS.test(address)) throw new Error(`"${address}" is not one email address`);
  }
  return clean.join(", ");
}

export interface OutgoingMail {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
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

/** Splits an address header into its addresses, quoted commas respected. */
export function splitAddresses(value: string): string[] {
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** One address as mail delivers to it: the angle-addr that ends "Name <address>"
 *  (a quoted name may itself hold brackets, so never the first one), else the
 *  whole text, trimmed and lowercased. */
export const bareAddress = (address: string) => (/<([^<>]*)>\s*$/.exec(address)?.[1] ?? address).trim().toLowerCase();

const BARE_ADDRESS = new RegExp(`^${ADDR}$`);

/** The one address a recipient string reaches, or null when it is not exactly
 *  one address. "header" reads it the way send_mail's To and Cc do (a bare
 *  address or "Name <address>"); "bare" accepts only a plain address, the way
 *  a calendar attendee is sent. A rule match built from these names the
 *  people the call really reaches. */
export function deliveredAddress(address: string, form: "header" | "bare" = "header"): string | null {
  const line = oneLine(address);
  return (form === "header" ? ONE_ADDRESS : BARE_ADDRESS).test(line) ? bareAddress(line) : null;
}

/** Who a reply goes to and the headers that thread it, from the thread's
 *  last real message. Drafts are skipped: Gmail returns them in a thread, and
 *  a reply answers what was sent, never an unsent draft (the assistant's own
 *  earlier one, say). `me` is the person's own address, kept off a reply-all. */
export function replyEnvelope(thread: GmailThread, replyAll: boolean, me?: string): Omit<OutgoingMail, "body"> {
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

async function threadForReply(deps: GoogleDeps, threadId: string, signal?: AbortSignal): Promise<GmailThread> {
  return googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/threads/${encodeURIComponent(threadId)}`, {
    query: { format: "metadata", metadataHeaders: THREADING_HEADERS },
  }, signal);
}

const describeEnvelope = (m: Omit<OutgoingMail, "body">) =>
  `To: ${m.to.join(", ")}${m.cc?.length ? `\nCc: ${m.cc.join(", ")}` : ""}\nSubject: ${m.subject}`;

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

// ── The tools ───────────────────────────────────────────────────────────────

const Addresses = Type.Array(Type.String(), { description: 'Email addresses, plain or as "Name <address>".', minItems: 1, maxItems: 50 });
const ThreadIds = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });

export function searchMailTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "search_mail",
    label: "Search mail",
    description:
      "Search the person's Gmail with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, in:inbox, has:attachment, and plain words). " +
      "Returns matching threads, newest first, with sender, subject, date and a snippet. Use read_thread to read one in full.",
    parameters: Type.Object({
      query: Type.String({ description: "A Gmail search, such as \"is:unread newer_than:2d\"." }),
      max: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_THREADS, description: "How many threads, 10 by default." })),
    }),
    risk: "read",
    source: "mail",
    run: async ({ query, max }, { signal }) => {
      const listed = await googleCall<{ threads?: { id: string }[] }>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/threads`, {
        query: { q: query, maxResults: max ?? 10 },
      }, signal);
      const ids = (listed?.threads ?? []).map((t) => t.id);
      if (ids.length === 0) return { content: `No threads match "${query}".`, details: { threads: 0 } };
      // A thread can fail on its own (deleted since the list, or refused for
      // load): the search shows the rest and says how many it skipped.
      const reads = await mapLimit(ids, SEARCH_READS_IN_FLIGHT, (id) =>
        googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/threads/${encodeURIComponent(id)}`, {
          query: { format: "metadata", metadataHeaders: ["From", "Subject", "Date"] },
        }, signal).then((thread) => ({ thread }), (error: unknown) => ({ error })));
      const threads = reads.flatMap((r) => ("thread" in r ? [r.thread] : []));
      const failed = reads.flatMap((r) => ("error" in r ? [r.error] : []));
      // Every read failing, or a stopped run, is the search failing.
      if (failed.length && (threads.length === 0 || signal?.aborted)) throw failed[0];
      const lines = threads.map((t) => {
        const messages = t.messages ?? [];
        const first = messages[0];
        // The latest sent message speaks for the thread. A thread of drafts
        // alone shows its last draft, marked.
        const sent = messages.filter((m) => !isDraft(m));
        const last = sent[sent.length - 1] ?? messages[messages.length - 1];
        const unread = messages.some((m) => m.labelIds?.includes("UNREAD"));
        const drafts = messages.length - sent.length;
        return [
          `Thread ${t.id} · ${dateOf(last)} · ${messages.length} message${messages.length === 1 ? "" : "s"}${unread ? " · unread" : ""}${drafts ? ` · ${drafts} unsent draft${drafts === 1 ? "" : "s"}` : ""}`,
          ...(last && isDraft(last) ? ["Draft (not sent)"] : []),
          `From: ${header(last?.payload, "From")}`,
          `Subject: ${header(first?.payload, "Subject")}`,
          `Snippet: ${last?.snippet ?? ""}`,
        ].join("\n");
      });
      const skipped = failed.length ? `\n\n[${failed.length} more thread${failed.length === 1 ? "" : "s"} matched but could not be read]` : "";
      return { content: lines.join("\n\n") + skipped, details: { threads: threads.length, ...(failed.length ? { skipped: failed.length } : {}) } };
    },
  });
}

export function readThreadTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "read_thread",
    label: "Read a thread",
    description: "Read one Gmail thread in full: every message's sender, recipients, date and text, and the names of any attachments.",
    parameters: Type.Object({ thread_id: Type.String({ description: "The thread id from search_mail." }) }),
    risk: "read",
    source: "mail",
    run: async ({ thread_id }, { signal }) => {
      const thread = await googleCall<GmailThread>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/threads/${encodeURIComponent(thread_id)}`, {
        query: { format: "full" },
      }, signal);
      const messages = thread.messages ?? [];
      // A draft is marked, so it never reads as a reply already sent.
      const draft = (m: GmailMessage) => (isDraft(m) ? ["Draft (not sent)"] : []);
      const whole = (m: GmailMessage) => {
        const { text: raw, attachments } = messageText(m.payload);
        // Cut in the fenced form too, so even the newest message fits whole.
        const text = untrustedBody(raw);
        const body = text.length > MESSAGE_BODY_MAX_CHARS ? `${text.slice(0, MESSAGE_BODY_MAX_CHARS)}\n[cut: the message goes on]` : text;
        return untrustedBody([
          ...draft(m),
          `From: ${header(m.payload, "From")}`,
          `To: ${header(m.payload, "To")}`,
          ...(header(m.payload, "Cc") ? [`Cc: ${header(m.payload, "Cc")}`] : []),
          `Date: ${header(m.payload, "Date") || dateOf(m)}`,
          `Subject: ${header(m.payload, "Subject")}`,
          ...(attachments.length ? [`Attachments: ${attachments.join(", ")}`] : []),
          "",
          body,
        ].join("\n"));
      };
      const short = (m: GmailMessage) =>
        untrustedBody([...draft(m), `From: ${header(m.payload, "From")}`, `Date: ${header(m.payload, "Date") || dateOf(m)}`, `Snippet: ${m.snippet ?? ""}`].join("\n"));
      // Newest first: each message stays whole while it fits; from the first
      // that does not, older ones are short, and past that they are left out.
      const SEPARATOR = "\n\n---\n\n";
      const blocks: string[] = [];
      let used = 0;
      let shortened = 0;
      let omitted = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        // The newest message is always shown whole (its body is capped already).
        const room = THREAD_MAX_CHARS - used - (blocks.length ? SEPARATOR.length : 0);
        let block = shortened ? short(messages[i]) : whole(messages[i]);
        const isShort = shortened > 0 || (blocks.length > 0 && block.length > room);
        if (isShort && !shortened) block = short(messages[i]);
        if (blocks.length > 0 && block.length > room) {
          omitted = i + 1;
          break;
        }
        if (isShort) shortened++;
        blocks.unshift(block);
        used += block.length + (blocks.length > 1 ? SEPARATOR.length : 0);
      }
      const note = [
        omitted ? `[${omitted} earliest message${omitted === 1 ? "" : "s"} left out]` : "",
        shortened ? `[${shortened} earlier message${shortened === 1 ? "" : "s"} shortened to sender, date and snippet]` : "",
      ].filter(Boolean).map((line) => `${line}\n\n`).join("");
      return {
        content: `Thread ${thread.id}\n\n${note}${blocks.join(SEPARATOR)}`,
        details: { messages: messages.length, ...(shortened ? { shortened } : {}), ...(omitted ? { omitted } : {}) },
      };
    },
  });
}

export function draftReplyTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "draft_reply",
    label: "Draft a reply",
    description:
      "Save a reply to a Gmail thread as a draft in the person's Drafts, threaded under the last message. Nothing is sent; the person can review and send it from Gmail, or ask you to send it with send_mail.",
    parameters: Type.Object({
      thread_id: Type.String(),
      body: Type.String({ description: "The reply's text, plain text." }),
      reply_all: Type.Optional(Type.Boolean({ description: "Also copy everyone else on the last message." })),
    }),
    risk: "read",
    // The envelope echoes addresses and a subject written by the thread's senders.
    source: "mail",
    run: async ({ thread_id, body, reply_all }, { signal }) => {
      const me = reply_all ? (await googleCall<{ emailAddress?: string }>(deps, GMAIL_READONLY_SCOPE, `${GMAIL_API}/profile`, {}, signal)).emailAddress : undefined;
      const envelope = replyEnvelope(await threadForReply(deps, thread_id, signal), !!reply_all, me);
      const raw = buildRawMessage({ ...envelope, body });
      const draft = await googleCall<{ id: string }>(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/drafts`, {
        method: "POST",
        body: { message: { raw, threadId: thread_id } },
      }, signal);
      return { content: `Draft saved (draft ${draft.id}).\n${describeEnvelope(envelope)}`, details: { draft_id: draft.id, to: envelope.to } };
    },
  });
}

export function createDraftTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "create_draft",
    label: "Draft an email",
    description: "Save a new email as a draft in the person's Gmail Drafts. Nothing is sent.",
    parameters: Type.Object({ to: Addresses, cc: Type.Optional(Addresses), subject: Type.String(), body: Type.String() }),
    risk: "read",
    run: async ({ to, cc, subject, body }, { signal }) => {
      const raw = buildRawMessage({ to, cc, subject, body });
      const draft = await googleCall<{ id: string }>(deps, GMAIL_MODIFY_SCOPE, `${GMAIL_API}/drafts`, { method: "POST", body: { message: { raw } } }, signal);
      return { content: `Draft saved (draft ${draft.id}) to ${to.join(", ")}: "${subject}".`, details: { draft_id: draft.id, to } };
    },
  });
}

export function sendMailTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "send_mail",
    label: "Send an email",
    description:
      "Send an email from the person's Gmail. Give the full message: recipients, subject and body, exactly as it should go out; the person approves this exact message. " +
      "To answer a thread, pass its thread_id and the message is sent as a reply in that thread.",
    parameters: Type.Object({
      to: Addresses,
      cc: Type.Optional(Addresses),
      subject: Type.String(),
      body: Type.String(),
      thread_id: Type.Optional(Type.String({ description: "The thread this answers, for a reply." })),
    }),
    risk: "write",
    run: async ({ to, cc, subject, body, thread_id }, { signal }) => {
      const threading = thread_id ? replyEnvelope(await threadForReply(deps, thread_id, signal), false) : undefined;
      const raw = buildRawMessage({
        to,
        cc,
        subject,
        body,
        ...(threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
        ...(threading?.references ? { references: threading.references } : {}),
      });
      const sent = await googleCall<{ id: string; threadId: string }>(deps, GMAIL_SEND_SCOPE, `${GMAIL_API}/messages/send`, {
        method: "POST",
        body: { raw, ...(thread_id ? { threadId: thread_id } : {}) },
      }, signal);
      return { content: `Sent to ${to.join(", ")}: "${subject}".`, details: { message_id: sent.id, thread_id: sent.threadId, to } };
    },
  });
}

export function archiveTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "archive",
    label: "Archive mail",
    description: "Archive Gmail threads: they leave the inbox and stay searchable in All Mail.",
    parameters: Type.Object({ thread_ids: ThreadIds }),
    risk: "write",
    run: async ({ thread_ids }, { signal }) => {
      await modifyThreads(deps, thread_ids, { removeLabelIds: ["INBOX"] }, signal);
      return { content: `Archived ${thread_ids.length} thread${thread_ids.length === 1 ? "" : "s"}.`, details: { threads: thread_ids.length } };
    },
  });
}

export function labelTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "label",
    label: "Label mail",
    description:
      "Add or remove Gmail labels on threads, by label name. A label added that does not exist yet is created. " +
      "System labels work too: STARRED, IMPORTANT, UNREAD (remove it to mark read), INBOX.",
    parameters: Type.Object({
      thread_ids: ThreadIds,
      add: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      remove: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
    }),
    risk: "write",
    run: async ({ thread_ids, add = [], remove = [] }, { signal }) => {
      if (add.length === 0 && remove.length === 0) throw new Error("Name at least one label to add or remove");
      await modifyThreads(deps, thread_ids, await resolveLabels(deps, add, remove, signal), signal);
      const change = [add.length ? `added ${add.join(", ")}` : "", remove.length ? `removed ${remove.join(", ")}` : ""].filter(Boolean).join(" and ");
      return { content: `On ${thread_ids.length} thread${thread_ids.length === 1 ? "" : "s"}: ${change}.`, details: { threads: thread_ids.length } };
    },
  });
}

/** Which Gmail tools a connection's grants allow (googleCapabilities). */
export function gmailTools(deps: GoogleDeps, can: Pick<GoogleCapabilities, "read_mail" | "modify_mail" | "send_mail">): Tool[] {
  return [
    ...(can.read_mail ? [searchMailTool(deps), readThreadTool(deps)] : []),
    ...(can.modify_mail ? [draftReplyTool(deps), createDraftTool(deps), archiveTool(deps), labelTool(deps)] : []),
    ...(can.send_mail ? [sendMailTool(deps)] : []),
  ];
}
