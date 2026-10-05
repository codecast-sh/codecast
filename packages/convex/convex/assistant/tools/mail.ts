// The hosted assistant's mail tools (plan pl-840): search and read threads,
// save drafts, send, archive and label. The tools are written against a
// Mailbox, the few thread-level verbs any mail engine offers, so what the
// assistant can do, how it shows mail and which calls ask the person first
// do not depend on which engine holds the mail. gmail.ts is today's Mailbox
// (Gmail's REST API with the owner's token); the spec moves mail to Whisk
// (ct-57102), which is another Mailbox, not a rewrite of these tools.
//
// Reads and drafts are risk "read": a draft changes nothing anyone else sees.
// Sending, archiving and labelling are "write" and pass the gate.
//
// Mail is outside content. Every tool whose result carries text from a
// message declares source "mail", so the harness fences it as data.
import { defineTool, Type, UNTRUSTED_MAX_CHARS, untrustedBody, type Tool } from "@platform/agent";
import type { GoogleCapabilities } from "../../googleOAuth";

/** The most threads one search reads. */
export const SEARCH_MAX_THREADS = 25;
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

// ── The seam ────────────────────────────────────────────────────────────────

/** One message as the tools show it. Header fields are the raw header text. */
export interface MailMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  /** The Date header as the sender wrote it. */
  date: string;
  /** When the mailbox received it, "YYYY-MM-DD HH:MM" UTC. */
  at: string;
  subject: string;
  snippet: string;
  /** An unsent draft, often the assistant's own: it never stands for the thread's latest word. */
  draft: boolean;
  unread: boolean;
  /** The readable body and attachment names, present when the thread was read in full. */
  text?: string;
  attachments?: string[];
}

export interface MailThread {
  id: string;
  messages: MailMessage[];
}

/** Who a reply goes to, its subject, and the headers that thread it. */
export interface ReplyEnvelope {
  to: string[];
  cc?: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
}

/** A message to save or send. With `threadId` it answers that thread, and
 *  the threading headers come from its ReplyEnvelope. */
export interface OutgoingMail {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

/** The verbs the mail tools need from a mail engine, as the conversation's owner. */
export interface Mailbox {
  /** Threads matching a search, newest first, with headers and snippets but
   *  no bodies. `skipped` counts matches that could not be read; a search
   *  where every read failed throws. */
  search(query: string, max: number, signal?: AbortSignal): Promise<{ threads: MailThread[]; skipped: number }>;
  /** One thread with every message's text. */
  thread(id: string, signal?: AbortSignal): Promise<MailThread>;
  /** How a reply to the thread's last sent message is addressed. With
   *  `replyAll`, everyone else on that message is copied, the person excepted. */
  replyEnvelope(threadId: string, replyAll: boolean, signal?: AbortSignal): Promise<ReplyEnvelope>;
  saveDraft(mail: OutgoingMail, signal?: AbortSignal): Promise<{ draftId: string }>;
  send(mail: OutgoingMail, signal?: AbortSignal): Promise<{ messageId: string; threadId: string }>;
  archive(threadIds: readonly string[], signal?: AbortSignal): Promise<void>;
  /** Adds and removes labels by name, creating a label to add that does not
   *  exist; an unknown label to remove fails the call with nothing changed. */
  label(threadIds: readonly string[], add: readonly string[], remove: readonly string[], signal?: AbortSignal): Promise<void>;
}

// ── Addresses ───────────────────────────────────────────────────────────────

/** A header value on one line: a line break in a value would start a header of its own. */
export const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const ADDR = "[^<>@\\s,;\"]+@[^<>@\\s,;\"]+";
/** One recipient: a bare address, or a display name and an address in angle
 *  brackets. An unquoted name may not hold ',', ';', '@' or a quote, so one
 *  entry can never stand for two recipients. */
export const ONE_ADDRESS = new RegExp(`^(?:${ADDR}|(?:"[^"\\\\]*"|[^<>@,;"]*)\\s*<${ADDR}>)$`);
const BARE_ADDRESS = new RegExp(`^${ADDR}$`);

/** Splits an address header into its addresses, quoted commas respected. */
export function splitAddresses(value: string): string[] {
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** One address as mail delivers to it: the angle-addr that ends "Name <address>"
 *  (a quoted name may itself hold brackets, so never the first one), else the
 *  whole text, trimmed and lowercased. */
export const bareAddress = (address: string) => (/<([^<>]*)>\s*$/.exec(address)?.[1] ?? address).trim().toLowerCase();

/** The one address a recipient string reaches, or null when it is not exactly
 *  one address. "header" reads it the way send_mail's To and Cc do (a bare
 *  address or "Name <address>"); "bare" accepts only a plain address, the way
 *  a calendar attendee is sent. A rule match built from these names the
 *  people the call really reaches. */
export function deliveredAddress(address: string, form: "header" | "bare" = "header"): string | null {
  const line = oneLine(address);
  return (form === "header" ? ONE_ADDRESS : BARE_ADDRESS).test(line) ? bareAddress(line) : null;
}

/** A subject as a thread knows it: without its reply and forward prefixes,
 *  spacing or case. Mail engines file a reply into its thread only when this
 *  matches (Gmail does), so a reworded reply would start a new thread. */
export const threadSubject = (subject: string) =>
  oneLine(subject).replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();

const describeEnvelope = (m: ReplyEnvelope) =>
  `To: ${m.to.join(", ")}${m.cc?.length ? `\nCc: ${m.cc.join(", ")}` : ""}\nSubject: ${m.subject}`;

// ── The tools ───────────────────────────────────────────────────────────────

const Addresses = Type.Array(Type.String(), { description: 'Email addresses, plain or as "Name <address>".', minItems: 1, maxItems: 50 });
const ThreadIds = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function searchMailTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "search_mail",
    label: "Search mail",
    description:
      "Search the person's mail with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, in:inbox, has:attachment, and plain words). " +
      "Returns matching threads, newest first, with sender, subject, date and a snippet. Use read_thread to read one in full.",
    parameters: Type.Object({
      query: Type.String({ description: "A Gmail search, such as \"is:unread newer_than:2d\"." }),
      max: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_THREADS, description: "How many threads, 10 by default." })),
    }),
    risk: "read",
    source: "mail",
    run: async ({ query, max }, { signal }) => {
      const { threads, skipped } = await mailbox.search(query, max ?? 10, signal);
      if (threads.length === 0 && skipped === 0) return { content: `No threads match "${query}".`, details: { threads: 0 } };
      const lines = threads.map((t) => {
        const messages = t.messages;
        const first = messages[0];
        // The latest sent message speaks for the thread. A thread of drafts
        // alone shows its last draft, marked.
        const sent = messages.filter((m) => !m.draft);
        const last = sent[sent.length - 1] ?? messages[messages.length - 1];
        const unread = messages.some((m) => m.unread);
        const drafts = messages.length - sent.length;
        return [
          `Thread ${t.id} · ${last?.at ?? ""} · ${plural(messages.length, "message")}${unread ? " · unread" : ""}${drafts ? ` · ${plural(drafts, "unsent draft")}` : ""}`,
          ...(last?.draft ? ["Draft (not sent)"] : []),
          `From: ${last?.from ?? ""}`,
          `Subject: ${first?.subject ?? ""}`,
          `Snippet: ${last?.snippet ?? ""}`,
        ].join("\n");
      });
      const more = skipped ? `\n\n[${plural(skipped, "more thread")} matched but could not be read]` : "";
      return { content: lines.join("\n\n") + more, details: { threads: threads.length, ...(skipped ? { skipped } : {}) } };
    },
  });
}

export function readThreadTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "read_thread",
    label: "Read a thread",
    description: "Read one mail thread in full: every message's sender, recipients, date and text, and the names of any attachments.",
    parameters: Type.Object({ thread_id: Type.String({ description: "The thread id from search_mail." }) }),
    risk: "read",
    source: "mail",
    run: async ({ thread_id }, { signal }) => {
      const thread = await mailbox.thread(thread_id, signal);
      const messages = thread.messages;
      // A draft is marked, so it never reads as a reply already sent.
      const draft = (m: MailMessage) => (m.draft ? ["Draft (not sent)"] : []);
      const whole = (m: MailMessage) => {
        // Cut in the fenced form too, so even the newest message fits whole.
        const text = untrustedBody(m.text ?? "");
        const body = text.length > MESSAGE_BODY_MAX_CHARS ? `${text.slice(0, MESSAGE_BODY_MAX_CHARS)}\n[cut: the message goes on]` : text;
        return untrustedBody([
          ...draft(m),
          `From: ${m.from}`,
          `To: ${m.to}`,
          ...(m.cc ? [`Cc: ${m.cc}`] : []),
          `Date: ${m.date || m.at}`,
          `Subject: ${m.subject}`,
          ...(m.attachments?.length ? [`Attachments: ${m.attachments.join(", ")}`] : []),
          "",
          body,
        ].join("\n"));
      };
      const short = (m: MailMessage) => untrustedBody([...draft(m), `From: ${m.from}`, `Date: ${m.date || m.at}`, `Snippet: ${m.snippet}`].join("\n"));
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
        omitted ? `[${plural(omitted, "earliest message")} left out]` : "",
        shortened ? `[${plural(shortened, "earlier message")} shortened to sender, date and snippet]` : "",
      ].filter(Boolean).map((line) => `${line}\n\n`).join("");
      return {
        content: `Thread ${thread.id}\n\n${note}${blocks.join(SEPARATOR)}`,
        details: { messages: messages.length, ...(shortened ? { shortened } : {}), ...(omitted ? { omitted } : {}) },
      };
    },
  });
}

export function draftReplyTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "draft_reply",
    label: "Draft a reply",
    description:
      "Save a reply to a mail thread as a draft in the person's Drafts, threaded under the last message. Nothing is sent; the person can review and send it from their mail, or ask you to send it with send_mail.",
    parameters: Type.Object({
      thread_id: Type.String(),
      body: Type.String({ description: "The reply's text, plain text." }),
      reply_all: Type.Optional(Type.Boolean({ description: "Also copy everyone else on the last message." })),
    }),
    risk: "read",
    // The envelope echoes addresses and a subject written by the thread's senders.
    source: "mail",
    run: async ({ thread_id, body, reply_all }, { signal }) => {
      const envelope = await mailbox.replyEnvelope(thread_id, !!reply_all, signal);
      const { draftId } = await mailbox.saveDraft({ ...envelope, body, threadId: thread_id }, signal);
      return { content: `Draft saved (draft ${draftId}).\n${describeEnvelope(envelope)}`, details: { draft_id: draftId, to: envelope.to } };
    },
  });
}

export function createDraftTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "create_draft",
    label: "Draft an email",
    description: "Save a new email as a draft in the person's Drafts. Nothing is sent.",
    parameters: Type.Object({ to: Addresses, cc: Type.Optional(Addresses), subject: Type.String(), body: Type.String() }),
    risk: "read",
    run: async ({ to, cc, subject, body }, { signal }) => {
      const { draftId } = await mailbox.saveDraft({ to, cc, subject, body }, signal);
      return { content: `Draft saved (draft ${draftId}) to ${to.join(", ")}: "${subject}".`, details: { draft_id: draftId, to } };
    },
  });
}

export function sendMailTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "send_mail",
    label: "Send an email",
    description:
      "Send an email from the person's mail. Give the full message: recipients, subject and body, exactly as it should go out; the person approves this exact message. " +
      "To answer a thread, pass its thread_id and the thread's own subject (as read_thread or draft_reply shows it): " +
      "a different subject would start a new thread and is refused.",
    parameters: Type.Object({
      to: Addresses,
      cc: Type.Optional(Addresses),
      // Always given, so the approval card shows the subject that goes out.
      subject: Type.String({ description: "For a reply, the thread's subject." }),
      body: Type.String(),
      thread_id: Type.Optional(Type.String({ description: "The thread this answers, for a reply." })),
    }),
    risk: "write",
    run: async ({ to, cc, subject, body, thread_id }, { signal }) => {
      if (!subject.trim()) throw new Error("A message needs a subject");
      let threading: ReplyEnvelope | undefined;
      if (thread_id) {
        threading = await mailbox.replyEnvelope(thread_id, false, signal);
        if (threadSubject(subject) !== threadSubject(threading.subject)) {
          // The thread's subject is written by its senders, so the refusal
          // points at read_thread's fenced copy rather than echoing it here.
          throw new Error("A reply keeps its thread's subject. Send it again with the subject read_thread shows.");
        }
      }
      const sentSubject = subject;
      const sent = await mailbox.send({
        to,
        cc,
        subject: sentSubject,
        body,
        ...(thread_id ? { threadId: thread_id } : {}),
        ...(threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
        ...(threading?.references ? { references: threading.references } : {}),
      }, signal);
      return { content: `Sent to ${to.join(", ")}: "${sentSubject}".`, details: { message_id: sent.messageId, thread_id: sent.threadId, to } };
    },
  });
}

export function archiveTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "archive",
    label: "Archive mail",
    description: "Archive mail threads: they leave the inbox and stay searchable in All Mail.",
    parameters: Type.Object({ thread_ids: ThreadIds }),
    risk: "write",
    run: async ({ thread_ids }, { signal }) => {
      await mailbox.archive(thread_ids, signal);
      return { content: `Archived ${plural(thread_ids.length, "thread")}.`, details: { threads: thread_ids.length } };
    },
  });
}

export function labelTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "label",
    label: "Label mail",
    description:
      "Add or remove labels on mail threads, by label name. A label added that does not exist yet is created. " +
      "System labels work too: STARRED, IMPORTANT, UNREAD (remove it to mark read), INBOX.",
    parameters: Type.Object({
      thread_ids: ThreadIds,
      add: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      remove: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
    }),
    risk: "write",
    run: async ({ thread_ids, add = [], remove = [] }, { signal }) => {
      if (add.length === 0 && remove.length === 0) throw new Error("Name at least one label to add or remove");
      await mailbox.label(thread_ids, add, remove, signal);
      const change = [add.length ? `added ${add.join(", ")}` : "", remove.length ? `removed ${remove.join(", ")}` : ""].filter(Boolean).join(" and ");
      return { content: `On ${plural(thread_ids.length, "thread")}: ${change}.`, details: { threads: thread_ids.length } };
    },
  });
}

/** The mail tools a connection's grants allow (googleCapabilities), over any Mailbox. */
export function mailTools(mailbox: Mailbox, can: Pick<GoogleCapabilities, "read_mail" | "modify_mail" | "send_mail">): Tool[] {
  return [
    ...(can.read_mail ? [searchMailTool(mailbox), readThreadTool(mailbox)] : []),
    ...(can.modify_mail ? [draftReplyTool(mailbox), createDraftTool(mailbox), archiveTool(mailbox), labelTool(mailbox)] : []),
    ...(can.send_mail ? [sendMailTool(mailbox)] : []),
  ];
}
