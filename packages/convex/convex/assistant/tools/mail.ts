// The hosted assistant's mail tools (plan pl-840): search and read threads,
// write replies in the person's voice, summarize, save drafts, send, archive
// and label. The tools are written against a Mailbox, the few thread-level
// verbs a mail engine offers, so what the assistant can do, how it shows mail
// and which calls ask the person first live here. whisk.ts is the Mailbox:
// codecast reaches mail only through Whisk (docs/architecture/hosted-
// assistant.md, "Mail and calendar go through Whisk"), and every thread the
// tools show carries its link to open it there.
//
// Reads, summaries, replies in the person's voice and drafts are risk "read":
// none changes anything anyone else sees. Sending, archiving and labelling
// are "write" and pass the gate.
//
// Mail is outside content. Every tool whose result carries text from a
// message declares source "mail", so the harness fences it as data.
import { defineTool, Type, UNTRUSTED_MAX_CHARS, untrustedBody, type Tool } from "@platform/agent";
import type { MailAbilities } from "../../lib/whisk";

/** The most threads one search returns. */
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

/** One message as the tools show it. Address fields are display text. */
export interface MailMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  /** When it was sent, "YYYY-MM-DD HH:MM UTC". */
  at: string;
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
  subject: string;
  /** Where the person opens the thread themself. */
  link?: string;
  messages: MailMessage[];
}

/** One search hit, without its messages' text. */
export interface MailThreadSummary {
  id: string;
  subject: string;
  /** When its latest message came, "YYYY-MM-DD HH:MM UTC". */
  at: string;
  messages: number;
  unread: boolean;
  /** Who wrote in it. */
  from: string;
  /** Its latest message's opening. */
  snippet: string;
  link?: string;
}

/** Who a reply goes to, its subject, and the message it answers. */
export interface ReplyEnvelope {
  to: string[];
  cc?: string[];
  subject: string;
  /** The id of the message the reply answers, which threads it. */
  answers?: string;
}

/** A message to save or send. With `threadId` it answers that thread, and
 *  `answers` names the message (from its ReplyEnvelope). `key` makes a
 *  repeat of the same call (a retry after a crash) land once. */
export interface OutgoingMail {
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  body: string;
  threadId?: string;
  answers?: string;
  key: string;
}

/** The verbs the mail tools need from a mail engine, as the conversation's owner. */
export interface Mailbox {
  /** Threads matching a search, newest first. */
  search(query: string, max: number, signal?: AbortSignal): Promise<MailThreadSummary[]>;
  /** One thread with every message's text. */
  thread(id: string, signal?: AbortSignal): Promise<MailThread>;
  /** How a reply to the thread's last sent message is addressed. With
   *  `replyAll`, everyone else on that message is copied, the person excepted. */
  replyEnvelope(threadId: string, replyAll: boolean, signal?: AbortSignal): Promise<ReplyEnvelope>;
  saveDraft(mail: OutgoingMail, signal?: AbortSignal): Promise<{ draftId: string }>;
  send(mail: OutgoingMail, signal?: AbortSignal): Promise<{ messageId: string; threadId: string }>;
  archive(threadIds: readonly string[], signal?: AbortSignal): Promise<void>;
  /** Adds and removes labels by name. A label that does not exist fails the
   *  call with nothing changed. */
  label(threadIds: readonly string[], add: readonly string[], remove: readonly string[], signal?: AbortSignal): Promise<void>;
  /** A reply to the thread written in the person's own voice, not saved. */
  suggestReply(threadId: string, instruction: string | undefined, signal?: AbortSignal): Promise<string>;
  /** What happened on the thread and what needs the person. */
  summarize(threadId: string, signal?: AbortSignal): Promise<string>;
  /** The link that opens a thread for the person. */
  link(threadId: string): string;
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

/** One recipient as a name and an address, checked to be exactly one address. */
export function recipient(address: string): { name?: string; email: string } {
  const line = oneLine(address);
  if (!ONE_ADDRESS.test(line)) throw new Error(`"${line}" is not one email address`);
  const email = bareAddress(line);
  const name = line.includes("<") ? line.slice(0, line.lastIndexOf("<")).trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return name ? { name, email } : { email };
}

/** A subject as a thread knows it: without its reply and forward prefixes,
 *  spacing or case. Mail engines file a reply into its thread only when this
 *  matches (Gmail does), so a reworded reply would start a new thread. */
export const threadSubject = (subject: string) =>
  oneLine(subject).replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();

/** A message as reply addressing reads it: addresses as display text. */
export type EnvelopeMessage = { id: string; from: string; to: string[]; cc: string[]; replyTo?: string; draft: boolean };

/**
 * Who a reply goes to and the message it answers, from the thread's last
 * sent message. Drafts are skipped: a reply answers what was sent, never an
 * unsent draft (the assistant's own earlier one, say). A thread that ends
 * with the person's own message (`own` says which addresses are theirs)
 * continues to whoever it went to; otherwise the reply goes to Reply-To, else
 * the sender. A reply-all copies everyone else on that message, never the
 * person. The subject is the thread's, with one "Re: ".
 */
export function replyEnvelopeFor(
  messages: readonly EnvelopeMessage[],
  subject: string,
  replyAll: boolean,
  own: (address: string) => boolean,
): ReplyEnvelope {
  const sent = messages.filter((m) => !m.draft);
  const last = sent[sent.length - 1];
  if (!last) throw new Error("That thread has no sent messages to reply to");
  const fromMe = own(bareAddress(last.from));
  const to = fromMe ? [...last.to] : [last.replyTo || last.from];
  const taken = new Set(to.map(bareAddress));
  const cc: string[] = [];
  if (replyAll) {
    for (const address of [...(fromMe ? [] : last.to), ...last.cc]) {
      const bare = bareAddress(address);
      if (taken.has(bare) || own(bare)) continue;
      taken.add(bare);
      cc.push(address);
    }
  }
  const base = oneLine(subject);
  return {
    to,
    ...(cc.length ? { cc } : {}),
    subject: /^re:/i.test(base) ? base : `Re: ${base}`,
    answers: last.id,
  };
}

const describeEnvelope = (m: ReplyEnvelope) =>
  `To: ${m.to.join(", ")}${m.cc?.length ? `\nCc: ${m.cc.join(", ")}` : ""}\nSubject: ${m.subject}`;

/** A stable key from the model's call id, so a call that lands twice (a
 *  crash after the engine accepted it) is one message, draft or event. */
export async function callKey(callId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`codecast-assistant:${callId}`));
  return `cc${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

// ── The tools ───────────────────────────────────────────────────────────────

const Addresses = Type.Array(Type.String(), { description: 'Email addresses, plain or as "Name <address>".', minItems: 1, maxItems: 50 });
const ThreadIds = Type.Array(Type.String(), { minItems: 1, maxItems: 50 });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const opens = (link: string | undefined) => (link ? [`Open in Whisk: ${link}`] : []);

export function searchMailTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "search_mail",
    label: "Search mail",
    description:
      "Search the person's mail with Gmail's search syntax (from:, to:, subject:, is:unread, newer_than:7d, in:inbox, has:attachment, and plain words), across every mailbox they keep in Whisk. " +
      "Returns matching threads, newest first, with who wrote, subject, date, a snippet and a link that opens the thread in Whisk. Use read_thread to read one in full.",
    parameters: Type.Object({
      query: Type.String({ description: "A Gmail search, such as \"is:unread newer_than:2d\"." }),
      max: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_MAX_THREADS, description: "How many threads, 10 by default." })),
    }),
    risk: "read",
    source: "mail",
    run: async ({ query, max }, { signal }) => {
      const threads = await mailbox.search(query, max ?? 10, signal);
      if (threads.length === 0) return { content: `No threads match "${query}".`, details: { threads: 0 } };
      const lines = threads.map((t) =>
        [
          `Thread ${t.id} · ${t.at} · ${plural(t.messages, "message")}${t.unread ? " · unread" : ""}`,
          `From: ${t.from}`,
          `Subject: ${t.subject}`,
          `Snippet: ${t.snippet}`,
          ...opens(t.link),
        ].join("\n"));
      return { content: lines.join("\n\n"), details: { threads: threads.length } };
    },
  });
}

export function readThreadTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "read_thread",
    label: "Read a thread",
    description: "Read one mail thread in full: its subject, every message's sender, recipients, date and text, the names of any attachments, and its link in Whisk.",
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
          `Date: ${m.at}`,
          ...(m.attachments?.length ? [`Attachments: ${m.attachments.join(", ")}`] : []),
          "",
          body,
        ].join("\n"));
      };
      const short = (m: MailMessage) => untrustedBody([...draft(m), `From: ${m.from}`, `Date: ${m.at}`, `Snippet: ${m.snippet}`].join("\n"));
      // Newest first: each message stays whole while it fits; from the first
      // that does not, older ones are short, and past that they are left out.
      const SEPARATOR = "\n\n---\n\n";
      const head = untrustedBody([`Thread ${thread.id}`, `Subject: ${thread.subject}`, ...opens(thread.link)].join("\n"));
      const blocks: string[] = [];
      let used = head.length;
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
        content: `${head}\n\n${note}${blocks.join(SEPARATOR)}`,
        details: { messages: messages.length, ...(shortened ? { shortened } : {}), ...(omitted ? { omitted } : {}) },
      };
    },
  });
}

export function summarizeThreadTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "summarize_thread",
    label: "Sum up a thread",
    description: "A short summary of one mail thread from Whisk: what happened and what needs the person. Quicker than read_thread for a long thread.",
    parameters: Type.Object({ thread_id: Type.String({ description: "The thread id from search_mail." }) }),
    risk: "read",
    // Written by a model from the thread's text, which anyone can send.
    source: "mail",
    run: async ({ thread_id }, { signal }) => {
      const summary = await mailbox.summarize(thread_id, signal);
      return { content: [`Thread ${thread_id}`, ...opens(mailbox.link(thread_id)), "", summary].join("\n"), details: { thread_id } };
    },
  });
}

export function suggestReplyTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "suggest_reply",
    label: "Write a reply in their voice",
    description:
      "Write a reply to a mail thread in the person's own voice: Whisk knows how they write to each person. Returns the text only; nothing is saved or sent. " +
      "Save it with draft_reply or, once the person says yes, send it with send_mail.",
    parameters: Type.Object({
      thread_id: Type.String(),
      instruction: Type.Optional(Type.String({ description: 'What the reply should do, such as "accept and propose Thursday" or "decline politely".', maxLength: 2_000 })),
    }),
    risk: "read",
    // Written by a model from the thread's text, which anyone can send.
    source: "mail",
    run: async ({ thread_id, instruction }, { signal }) => {
      const text = await mailbox.suggestReply(thread_id, instruction, signal);
      return { content: `A reply to thread ${thread_id}, not saved or sent:\n\n${text}`, details: { thread_id } };
    },
  });
}

export function draftReplyTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "draft_reply",
    label: "Draft a reply",
    description:
      "Save a reply to a mail thread as a draft in Whisk, threaded under the last message. Nothing is sent; the person can review and send it from Whisk, or ask you to send it with send_mail.",
    parameters: Type.Object({
      thread_id: Type.String(),
      body: Type.String({ description: "The reply's text, plain text." }),
      reply_all: Type.Optional(Type.Boolean({ description: "Also copy everyone else on the last message." })),
    }),
    risk: "read",
    // The envelope echoes addresses and a subject written by the thread's senders.
    source: "mail",
    run: async ({ thread_id, body, reply_all }, { callId, signal }) => {
      const envelope = await mailbox.replyEnvelope(thread_id, !!reply_all, signal);
      const { draftId } = await mailbox.saveDraft({ ...envelope, body, threadId: thread_id, key: await callKey(callId) }, signal);
      return {
        content: [`Draft saved (draft ${draftId}).`, describeEnvelope(envelope), ...opens(mailbox.link(thread_id))].join("\n"),
        details: { draft_id: draftId, to: envelope.to },
      };
    },
  });
}

export function createDraftTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "create_draft",
    label: "Draft an email",
    description: "Save a new email as a draft in Whisk, from the person's main mailbox. Nothing is sent.",
    parameters: Type.Object({ to: Addresses, cc: Type.Optional(Addresses), subject: Type.String(), body: Type.String() }),
    risk: "read",
    run: async ({ to, cc, subject, body }, { callId, signal }) => {
      const { draftId } = await mailbox.saveDraft({ to, cc, subject, body, key: await callKey(callId) }, signal);
      return { content: `Draft saved (draft ${draftId}) to ${to.join(", ")}: "${subject}".`, details: { draft_id: draftId, to } };
    },
  });
}

export function sendMailTool(mailbox: Mailbox): Tool {
  return defineTool({
    name: "send_mail",
    label: "Send an email",
    description:
      "Send an email through Whisk. Give the full message: recipients, subject and body, exactly as it should go out; the person approves this exact message. " +
      "A reply goes from the mailbox that holds the thread; a new message from the person's main mailbox. " +
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
    run: async ({ to, cc, subject, body, thread_id }, { callId, signal }) => {
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
      const sent = await mailbox.send({
        to,
        cc,
        subject,
        body,
        key: await callKey(callId),
        ...(thread_id ? { threadId: thread_id } : {}),
        ...(threading?.answers ? { answers: threading.answers } : {}),
      }, signal);
      return { content: `Sent to ${to.join(", ")}: "${subject}".`, details: { message_id: sent.messageId, thread_id: sent.threadId, to } };
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
      "Add or remove labels on mail threads, by label name. The label must already exist in that mailbox. " +
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

/** The mail tools a grant allows (whiskAbilities), over any Mailbox. Writing
 *  a reply in the person's voice drafts from the thread, so it comes with
 *  the drafting set. */
export function mailTools(mailbox: Mailbox, can: Pick<MailAbilities, "read_mail" | "modify_mail" | "send_mail">): Tool[] {
  return [
    ...(can.read_mail ? [searchMailTool(mailbox), readThreadTool(mailbox), summarizeThreadTool(mailbox)] : []),
    ...(can.modify_mail
      ? [suggestReplyTool(mailbox), draftReplyTool(mailbox), createDraftTool(mailbox), archiveTool(mailbox), labelTool(mailbox)]
      : []),
    ...(can.send_mail ? [sendMailTool(mailbox)] : []),
  ];
}
