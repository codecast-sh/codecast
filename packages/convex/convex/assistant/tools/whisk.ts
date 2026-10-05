// Whisk as the hosted assistant's Mailbox (mail.ts) and Calendar
// (calendar.ts), plan pl-840. Every verb is a call to the same Whisk Convex
// function the `whisk` CLI makes (~/src/mail/packages/cli), through a
// WhiskCall bound to the person's app token (lib/whisk.ts, convex/whisk.ts):
// reads from Whisk's synced copy of the mailbox and calendar, writes through
// its one write rail (dispatch:dispatch), which queues them for Gmail and
// Google Calendar. Whisk shapes stop here; the tools and their rules live in
// mail.ts and calendar.ts.
//
// Whisk keeps several mailboxes for one person. A thread is read, answered,
// archived and labelled in the mailbox that holds it (its account_id); new
// mail and new events go from the person's main mailbox, the one Whisk lists
// first.
import { htmlToText } from "../../lib/linkPreviewMeta";
import { whiskThreadLink, type WhiskCall } from "../../lib/whisk";
import { bareAddress, recipient, replyEnvelopeFor, SEARCH_MAX_THREADS, type Mailbox, type MailMessage } from "./mail";
import type { Calendar, CalendarEvent } from "./calendar";

// ── Whisk's shapes (its packages/shared/src/store/types.ts) ─────────────────

type Address = { name?: string; email: string };
type WhiskAccount = { _id: string; email: string; send_as?: { email: string }[] };
type WhiskThread = {
  _id: string;
  account_id: string;
  gmail_id: string;
  subject: string;
  snippet: string;
  participants: Address[];
  message_count: number;
  last_at: number;
  is_unread: boolean;
  label_ids: string[];
  deleted?: boolean;
};
type WhiskMessage = {
  gmail_id: string;
  from: Address;
  to: Address[];
  cc?: Address[];
  reply_to?: Address;
  date: number;
  snippet: string;
  body_text?: string;
  body_html?: string;
  label_ids: string[];
  is_unread: boolean;
  attachments?: { filename?: string }[];
};
type WhiskLabel = { account_id: string; gmail_id: string; name: string; kind: "system" | "user"; deleted?: boolean };
type WhiskCalendarRow = { account_id: string; google_id: string; primary?: boolean; access_role: string; time_zone?: string; deleted?: boolean };
type WhiskEvent = {
  account_id: string;
  calendar_google_id: string;
  google_id: string;
  summary: string;
  description?: string;
  location?: string;
  start: number;
  end: number;
  all_day: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  html_link?: string;
  attendees: { email: string; response_status?: string; self?: boolean; organizer?: boolean }[];
  organizer?: { email: string; self?: boolean };
  deleted?: boolean;
};

/** Whisk's system label ids, the names the label tool accepts for them. */
const INBOX = "INBOX";
const DRAFT = "DRAFT";

const shown = (a: Address | undefined) => (!a ? "" : a.name ? `${a.name} <${a.email}>` : a.email);
const shownList = (list: readonly Address[] | undefined) => (list ?? []).map(shown).join(", ");
/** A Whisk time as the tools show it: "YYYY-MM-DD HH:MM UTC". */
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The person's mailboxes, read once per turn: the main one first. */
function rosterOf(call: WhiskCall) {
  let roster: Promise<WhiskAccount[]> | undefined;
  const accounts = (signal?: AbortSignal) =>
    (roster ??= call<{ accounts?: WhiskAccount[] }>("query", "sync:getAccount", {}, signal).then((r) => r?.accounts ?? []).catch((e) => {
      roster = undefined;
      throw e;
    }));
  return {
    accounts,
    async main(signal?: AbortSignal): Promise<WhiskAccount> {
      const [first] = await accounts(signal);
      if (!first) throw new Error("No mailbox is connected in Whisk. Ask the person to add one in Whisk (whisk.email), then try again.");
      return first;
    },
    /** Whether an address is one of the person's own, in any mailbox. */
    async own(signal?: AbortSignal): Promise<(address: string) => boolean> {
      const mine = new Set((await accounts(signal)).flatMap((a) => [a.email, ...(a.send_as ?? []).map((s) => s.email)]).map(bareAddress));
      return (address) => mine.has(bareAddress(address));
    },
  };
}

// ── The Mailbox ─────────────────────────────────────────────────────────────

/** The person's mail in Whisk as a Mailbox. Nothing is called until a verb runs. */
export function whiskMailbox(call: WhiskCall, webUrl?: string): Mailbox {
  const roster = rosterOf(call);
  const link = (id: string) => whiskThreadLink(id, webUrl);

  /** Thread rows for ids (thread or message ids), each in its own mailbox.
   *  An id the person cannot see fails the call before anything changes. */
  const resolve = async (ids: readonly string[], signal?: AbortSignal): Promise<WhiskThread[]> => {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const rows = await call<WhiskThread[]>("query", "sync:threadsByIds", { gmailIds: unique }, signal);
    if ((rows ?? []).length < unique.length) {
      const found = new Set((rows ?? []).map((r) => r.gmail_id));
      const missing = unique.filter((id) => !found.has(id));
      throw new Error(`No thread ${missing.join(", ")} in the person's mail`);
    }
    return rows;
  };
  const one = async (id: string, signal?: AbortSignal) => (await resolve([id], signal))[0];

  const messagesOf = (thread: WhiskThread, signal?: AbortSignal) =>
    call<WhiskMessage[]>("query", "sync:threadMessages", { threadGmailId: thread.gmail_id, accountId: thread.account_id }, signal);

  /** One label op per mailbox, as every gesture in Whisk sends them. */
  const applyOps = async (threads: readonly WhiskThread[], delta: (accountId: string) => { add: string[]; remove: string[] }, signal?: AbortSignal) => {
    const byAccount = new Map<string, string[]>();
    for (const t of threads) byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.gmail_id]);
    const ops = [...byAccount].map(([account_id, thread_gmail_ids]) => {
      const { add, remove } = delta(account_id);
      return { account_id, thread_gmail_ids, add_label_ids: add, remove_label_ids: remove };
    });
    await call("mutation", "dispatch:dispatch", { action: "applyThreadOps", args: [{ ops }] }, signal);
  };

  /** The fields a draft and a send share. */
  const outgoing = async (mail: Parameters<Mailbox["send"]>[0], signal?: AbortSignal) => {
    const account = mail.threadId ? (await one(mail.threadId, signal)).account_id : (await roster.main(signal))._id;
    if (mail.to.length === 0) throw new Error("A message needs at least one recipient");
    return {
      client_id: mail.key,
      account_id: account,
      to: mail.to.map(recipient),
      cc: (mail.cc ?? []).map(recipient),
      bcc: [],
      subject: mail.subject,
      body_text: mail.body,
      ...(mail.threadId ? { thread_gmail_id: mail.threadId } : {}),
      ...(mail.answers ? { reply_to_gmail_id: mail.answers } : {}),
    };
  };

  return {
    link,

    async search(query, max, signal) {
      const limit = Math.min(max, SEARCH_MAX_THREADS);
      const rows: WhiskThread[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      // Whisk asks Gmail a page at a time across every mailbox; a few pages
      // are plenty for a search that shows at most SEARCH_MAX_THREADS.
      for (let page = 0; page < 4 && rows.length < limit; page++) {
        const result: { rows: WhiskThread[]; cursor: string | null } = await call("action", "search:runFullSearch", { q: query, ...(cursor ? { cursor } : {}) }, signal);
        for (const row of result?.rows ?? []) {
          if (row.deleted || seen.has(row._id)) continue;
          seen.add(row._id);
          rows.push(row);
        }
        cursor = result?.cursor ?? null;
        if (!cursor) break;
      }
      return rows
        .sort((a, b) => b.last_at - a.last_at)
        .slice(0, limit)
        .map((t) => ({
          id: t.gmail_id,
          subject: t.subject,
          at: when(t.last_at),
          messages: t.message_count,
          unread: t.is_unread,
          from: shownList(t.participants),
          snippet: t.snippet,
          link: link(t.gmail_id),
        }));
    },

    async thread(id, signal) {
      const thread = await one(id, signal);
      const rows = await messagesOf(thread, signal);
      const messages: MailMessage[] = rows.map((m) => ({
        id: m.gmail_id,
        from: shown(m.from),
        to: shownList(m.to),
        cc: shownList(m.cc),
        at: when(m.date),
        snippet: m.snippet,
        draft: m.label_ids.includes(DRAFT),
        unread: m.is_unread,
        text: (m.body_text?.trim() || htmlToText(m.body_html ?? "")).replace(/\r\n/g, "\n"),
        attachments: (m.attachments ?? []).map((a) => a.filename).filter((f): f is string => !!f),
      }));
      return { id: thread.gmail_id, subject: thread.subject, link: link(thread.gmail_id), messages };
    },

    async replyEnvelope(threadId, replyAll, signal) {
      const thread = await one(threadId, signal);
      const [rows, own] = await Promise.all([messagesOf(thread, signal), roster.own(signal)]);
      return replyEnvelopeFor(
        rows.map((m) => ({
          id: m.gmail_id,
          from: shown(m.from),
          to: (m.to ?? []).map(shown),
          cc: (m.cc ?? []).map(shown),
          ...(m.reply_to ? { replyTo: shown(m.reply_to) } : {}),
          draft: m.label_ids.includes(DRAFT),
        })),
        thread.subject,
        replyAll,
        own,
      );
    },

    async saveDraft(mail, signal) {
      const fields = await outgoing(mail, signal);
      const saved = await call<{ client_id: string }>("mutation", "dispatch:dispatch", {
        action: "saveDraft",
        args: [{ ...fields, mode: mail.threadId ? "reply" : "new" }],
      }, signal);
      return { draftId: saved?.client_id ?? fields.client_id };
    },

    async send(mail, signal) {
      const sent = await call<{ message_gmail_id: string; thread_gmail_id: string }>("mutation", "dispatch:dispatch", {
        action: "sendMessage",
        args: [await outgoing(mail, signal)],
      }, signal);
      return { messageId: sent.message_gmail_id, threadId: sent.thread_gmail_id };
    },

    async archive(threadIds, signal) {
      await applyOps(await resolve(threadIds, signal), () => ({ add: [], remove: [INBOX] }), signal);
    },

    async label(threadIds, add, remove, signal) {
      const threads = await resolve(threadIds, signal);
      const labels = (await call<WhiskLabel[]>("query", "sync:listLabels", {}, signal)).filter((l) => !l.deleted);
      // A user label has its own id in each mailbox even when names match, so
      // every name is found in every mailbox the threads live in, before
      // anything changes.
      const idIn = (accountId: string, name: string) => {
        const wanted = name.trim().toLowerCase();
        const hit = labels.find((l) => l.account_id === accountId && (l.name.toLowerCase() === wanted || l.gmail_id.toLowerCase() === wanted));
        if (!hit) throw new Error(`No label named "${name}" in that mailbox. Labels are made in Whisk.`);
        return hit.gmail_id;
      };
      const deltas = new Map<string, { add: string[]; remove: string[] }>();
      for (const accountId of new Set(threads.map((t) => t.account_id))) {
        deltas.set(accountId, { add: add.map((n) => idIn(accountId, n)), remove: remove.map((n) => idIn(accountId, n)) });
      }
      await applyOps(threads, (accountId) => deltas.get(accountId)!, signal);
    },

    async suggestReply(threadId, instruction, signal) {
      const thread = await one(threadId, signal);
      const result = await call<{ body_text: string }>("action", "ai/actions:draftReply", {
        threadGmailId: thread.gmail_id,
        accountId: thread.account_id,
        ...(instruction ? { instruction } : {}),
      }, signal);
      return result.body_text;
    },

    async summarize(threadId, signal) {
      const thread = await one(threadId, signal);
      const result = await call<{ summary: string }>("action", "ai/actions:summarizeThread", {
        threadGmailId: thread.gmail_id,
        accountId: thread.account_id,
      }, signal);
      return result.summary;
    },
  };
}

// ── The Calendar ────────────────────────────────────────────────────────────

/** The most event pages a turn reads from Whisk (2,000 events a page). */
const EVENT_PAGES_MAX = 10;

/** A Whisk event in the tools' event shape. An all-day event's dates are
 *  UTC midnights with an exclusive end, which is Google's `date` form. */
export function toCalendarEvent(e: WhiskEvent): CalendarEvent {
  const edge = (ms: number) => (e.all_day ? { date: new Date(ms).toISOString().slice(0, 10) } : { dateTime: new Date(ms).toISOString() });
  return {
    id: e.google_id,
    status: e.status,
    summary: e.summary,
    ...(e.description ? { description: e.description } : {}),
    ...(e.location ? { location: e.location } : {}),
    start: edge(e.start),
    end: edge(e.end),
    attendees: e.attendees.map((a) => ({
      email: a.email,
      ...(a.response_status ? { responseStatus: a.response_status } : {}),
      ...(a.self ? { self: true } : {}),
      ...(a.organizer ? { organizer: true } : {}),
    })),
    ...(e.organizer ? { organizer: e.organizer } : {}),
    ...(e.html_link ? { htmlLink: e.html_link } : {}),
  };
}

/** An event edge from the tools as Whisk's milliseconds. */
function edgeMs(edge: unknown, what: string): number {
  const t = edge as { dateTime?: string } | undefined;
  const ms = t?.dateTime ? Date.parse(t.dateTime) : NaN;
  if (Number.isNaN(ms)) throw new Error(`${what} must be a time`);
  return ms;
}

const NOTIFY_GUESTS = "Whisk emails every guest about this, so ask again with notify set to true once the person agrees to that.";

/** The person's calendars in Whisk as a Calendar: their main mailbox's
 *  primary calendar takes new events; reads cover every mailbox's primary
 *  calendar. Nothing is called until a verb runs. */
export function whiskCalendar(call: WhiskCall): Calendar {
  const roster = rosterOf(call);
  let read: Promise<{ calendars: WhiskCalendarRow[]; events: WhiskEvent[]; more: boolean }> | undefined;

  /** Calendars and events, read once per turn. listEvents is a change feed,
   *  so its pages are drained and the window filtered here. */
  const everything = (signal?: AbortSignal) =>
    (read ??= (async () => {
      const calendars = (await call<WhiskCalendarRow[]>("query", "calendar/read:listCalendars", {}, signal)).filter((c) => !c.deleted);
      const events = new Map<string, WhiskEvent>();
      let since: number | undefined;
      let more = false;
      for (let page = 0; page < EVENT_PAGES_MAX; page++) {
        const result = await call<{ rows: WhiskEvent[]; nextSince: number; hasMore: boolean }>("query", "calendar/read:listEvents", since === undefined ? {} : { since }, signal);
        for (const row of result.rows) events.set(`${row.account_id}:${row.calendar_google_id}:${row.google_id}`, row);
        more = result.hasMore;
        if (!more) break;
        since = result.nextSince;
      }
      return { calendars, events: [...events.values()].filter((e) => !e.deleted), more };
    })().catch((e) => {
      read = undefined;
      throw e;
    }));

  const primaries = (calendars: WhiskCalendarRow[]) => calendars.filter((c) => c.primary);
  const onPrimary = (calendars: WhiskCalendarRow[], e: WhiskEvent) =>
    primaries(calendars).some((c) => c.account_id === e.account_id && c.google_id === e.calendar_google_id);

  const find = async (id: string, signal?: AbortSignal) => {
    const { calendars, events } = await everything(signal);
    const hit = events.find((e) => e.google_id === id && onPrimary(calendars, e));
    if (!hit) throw new Error(`No event ${id} on the person's calendar`);
    return hit;
  };

  /** The calendar new events go on: the main mailbox's writable primary. */
  const home = async (signal?: AbortSignal) => {
    const [{ calendars }, main] = await Promise.all([everything(signal), roster.main(signal)]);
    const writable = (c: WhiskCalendarRow) => ["owner", "writer"].includes(c.access_role);
    const calendar = primaries(calendars).find((c) => c.account_id === main._id && writable(c)) ?? primaries(calendars).find(writable);
    if (!calendar) throw new Error("No calendar the assistant can add to. Ask the person to turn on Calendar in Whisk.");
    return calendar;
  };

  return {
    async events(from, to, opts, signal) {
      const { calendars, events, more } = await everything(signal);
      const words = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matches = (e: WhiskEvent) => {
        const text = [e.summary, e.description, e.location, ...e.attendees.map((a) => a.email)].join(" ").toLowerCase();
        return words.every((w) => text.includes(w));
      };
      const inWindow = events
        .filter((e) => onPrimary(calendars, e) && e.end > from && e.start < to && matches(e))
        .sort((a, b) => a.start - b.start);
      const cap = opts.pageSize * opts.pages;
      const main = await roster.main(signal).catch(() => undefined);
      const zone = primaries(calendars).find((c) => c.account_id === main?._id)?.time_zone ?? primaries(calendars)[0]?.time_zone;
      return {
        items: inWindow.slice(0, cap).map(toCalendarEvent),
        ...(zone ? { timeZone: zone } : {}),
        // Unread pages of the change feed could hold events in the window.
        more: inWindow.length > cap || more,
      };
    },

    event: async (id, signal) => toCalendarEvent(await find(id, signal)),

    async insert(event, notify, signal) {
      const attendees = (event.attendees ?? []).map((a) => a.email);
      if (attendees.length && !notify) throw new Error(NOTIFY_GUESTS);
      const calendar = await home(signal);
      const start = edgeMs(event.start, "start");
      const end = edgeMs(event.end, "end");
      const made = await call<{ google_id: string }>("mutation", "dispatch:dispatch", {
        action: "createEvent",
        args: [{
          client_id: event.id,
          account_id: calendar.account_id,
          calendar_google_id: calendar.google_id,
          summary: event.summary ?? "",
          start,
          end,
          all_day: false,
          attendees,
          ...(event.description ? { description: event.description } : {}),
          ...(event.location ? { location: event.location } : {}),
        }],
      }, signal);
      return {
        id: made.google_id,
        summary: event.summary,
        start: { dateTime: new Date(start).toISOString() },
        end: { dateTime: new Date(end).toISOString() },
      };
    },

    async patch(id, patch, notify, signal) {
      const current = await find(id, signal);
      const guests = current.attendees.some((a) => !a.self) || (Array.isArray(patch.attendees) && patch.attendees.length > 0);
      if (guests && !notify) throw new Error(NOTIFY_GUESTS);
      const change: Record<string, unknown> = {};
      if (patch.summary !== undefined) change.summary = patch.summary;
      if (patch.description !== undefined) change.description = patch.description;
      if (patch.location !== undefined) change.location = patch.location;
      if (patch.start !== undefined || patch.end !== undefined) {
        change.start = patch.start !== undefined ? edgeMs(patch.start, "start") : current.start;
        change.end = patch.end !== undefined ? edgeMs(patch.end, "end") : current.end;
        change.all_day = false;
      }
      if (Array.isArray(patch.attendees)) change.attendees = (patch.attendees as { email: string }[]).map((a) => a.email);
      await call("mutation", "dispatch:dispatch", {
        action: "updateEvent",
        args: [{ account_id: current.account_id, calendar_google_id: current.calendar_google_id, google_id: current.google_id, patch: change }],
      }, signal);
      // The event as it now stands, from what was changed.
      return toCalendarEvent({
        ...current,
        ...(change.summary !== undefined ? { summary: String(change.summary) } : {}),
        ...(change.start !== undefined ? { start: change.start as number, end: change.end as number, all_day: false } : {}),
      });
    },
  };
}
