// The hosted assistant's Calendar tools (plan pl-840): list events, find free
// time, create and update events on the person's primary Google calendar,
// over the Calendar REST API with the owner's token (google.ts). Listing and
// finding are risk "read"; creating and updating are "write" and pass the
// gate. Event titles and descriptions are written by whoever sent the
// invitation, so every tool that returns them declares source "calendar".
import { defineTool, Type, type Tool } from "@platform/agent";
import { CALENDAR_EVENTS_SCOPE } from "../../googleOAuth";
import { googleCall, type GoogleDeps } from "./google";
import { dayBounds, wallClockAt } from "../../lib/teamDay";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary";

/** The longest window find_free_time searches. */
export const FREE_TIME_MAX_DAYS = 14;
const SLOT_STEP_MS = 15 * 60 * 1000;

type EventTime = { dateTime?: string; date?: string; timeZone?: string };
export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  transparency?: string;
  attendees?: { email: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  htmlLink?: string;
};
type EventList = { items?: CalendarEvent[]; timeZone?: string; nextPageToken?: string };
/** Events read for a window, and whether Google holds more past the last one read. */
type EventRead = { items: CalendarEvent[]; timeZone?: string; more: boolean };

/** A time the model gave, which must carry its offset so it names one instant. */
export function instant(value: string, what: string): number {
  const ms = Date.parse(value);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) || Number.isNaN(ms)) {
    throw new Error(`${what} must be an ISO 8601 time with its UTC offset, like 2026-10-06T10:00:00-07:00`);
  }
  return ms;
}

/** The instant of an event edge. An all-day event's date is local midnight
 *  in the calendar's zone, not UTC midnight: a Monday off in Los Angeles
 *  blocks Monday there. */
function edgeMs(t: EventTime | undefined, timeZone: string): number {
  if (t?.dateTime) return Date.parse(t.dateTime);
  return localMidnight(t?.date ?? "", t?.timeZone ?? timeZone);
}
const startMs = (e: CalendarEvent, timeZone = "UTC") => edgeMs(e.start, timeZone);
const endMs = (e: CalendarEvent, timeZone = "UTC") => edgeMs(e.end, timeZone);

/** Formats instants and ranges in the calendar's own zone, falling back to
 *  UTC when the runtime cannot. A range within one day names the day once. */
function formatterFor(timeZone: string | undefined) {
  const build = (zone: string) => ({
    zone,
    date: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric" }),
    time: new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }),
  });
  let f: ReturnType<typeof build>;
  try {
    f = build(timeZone ?? "UTC");
  } catch {
    f = build("UTC");
  }
  const at = (ms: number) => `${f.date.format(ms)}, ${f.time.format(ms)}`;
  return {
    zone: f.zone,
    at,
    range: (a: number, b: number) => (f.date.format(a) === f.date.format(b) ? `${at(a)} to ${f.time.format(b)}` : `${at(a)} to ${at(b)}`),
  };
}

/** The instant local midnight starts `date` (YYYY-MM-DD) in `timeZone`,
 *  NaN for a missing date. lib/teamDay settles daylight saving days and
 *  unknown zones. */
export function localMidnight(date: string, timeZone: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? dayBounds(date, timeZone).start : NaN;
}

function describeEvent(e: CalendarEvent, range: (a: number, b: number) => string): string {
  const allDay = !e.start?.dateTime;
  const when = allDay ? `${e.start?.date} (all day)` : range(startMs(e), endMs(e));
  const others = (e.attendees ?? []).filter((a) => !a.self).map((a) => `${a.email}${a.responseStatus && a.responseStatus !== "needsAction" ? ` (${a.responseStatus})` : ""}`);
  const mine = e.attendees?.find((a) => a.self)?.responseStatus;
  return [
    `Event ${e.id} · ${when} · ${e.summary ?? "(no title)"}`,
    ...(e.location ? [`Where: ${e.location}`] : []),
    ...(others.length ? [`With: ${others.slice(0, 10).join(", ")}${others.length > 10 ? `, and ${others.length - 10} more` : ""}`] : []),
    ...(mine && mine !== "accepted" ? [`Your answer: ${mine}`] : []),
    ...(e.description ? [`Notes: ${e.description.length > 500 ? `${e.description.slice(0, 500)}…` : e.description}`] : []),
  ].join("\n");
}

/** Events in a window, oldest first, following Google's pages up to `pages`
 *  of `pageSize`. `more` says the window holds events past the last one read. */
async function listEvents(
  deps: GoogleDeps,
  from: number,
  to: number,
  opts: { signal?: AbortSignal; q?: string; pageSize: number; pages: number },
): Promise<EventRead> {
  const items: CalendarEvent[] = [];
  let timeZone: string | undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < opts.pages; page++) {
    const list = await googleCall<EventList>(deps, CALENDAR_EVENTS_SCOPE, `${CALENDAR_API}/events`, {
      query: {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: opts.pageSize,
        q: opts.q,
        pageToken,
      },
    }, opts.signal);
    items.push(...(list.items ?? []));
    timeZone ??= list.timeZone;
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  return { items, timeZone, more: !!pageToken };
}

/** How many events list_events reads and shows. */
export const LIST_EVENTS_MAX = 100;
/** How many pages of 250 find_free_time reads before it shortens its search. */
export const FREE_TIME_MAX_PAGES = 4;

/** Whether an event blocks time: not cancelled, not marked free, not declined. */
export function isBusy(e: CalendarEvent): boolean {
  if (e.status === "cancelled" || e.transparency === "transparent") return false;
  return e.attendees?.find((a) => a.self)?.responseStatus !== "declined";
}

export interface FreeTimeAsk {
  from: number;
  to: number;
  durationMs: number;
  timeZone: string;
  /** Minutes past local midnight. */
  dayStart: number;
  dayEnd: number;
  weekdaysOnly: boolean;
}

/** Free ranges at least `durationMs` long inside working hours, between busy events. */
export function freeRanges(events: readonly CalendarEvent[], ask: FreeTimeAsk): { start: number; end: number }[] {
  const busy = events.filter(isBusy).map((e) => [startMs(e, ask.timeZone), endMs(e, ask.timeZone)] as const);
  const clock = (ms: number) => wallClockAt(ms, ask.timeZone);
  const inHours = (ms: number) => {
    const c = clock(ms);
    return c.minutes >= ask.dayStart && c.minutes < ask.dayEnd && (!ask.weekdaysOnly || (c.weekday >= 1 && c.weekday <= 5));
  };
  const ranges: { start: number; end: number }[] = [];
  let open: { start: number; end: number } | null = null;
  const first = Math.ceil(ask.from / SLOT_STEP_MS) * SLOT_STEP_MS;
  for (let t = first; t + SLOT_STEP_MS <= ask.to; t += SLOT_STEP_MS) {
    const free = inHours(t) && !busy.some(([s, e]) => s < t + SLOT_STEP_MS && e > t);
    // A range stays within one local day: an overnight gap is two ranges.
    if (free && open && open.end === t && clock(open.start).date === clock(t).date) open.end = t + SLOT_STEP_MS;
    else if (free) {
      if (open) ranges.push(open);
      open = { start: t, end: t + SLOT_STEP_MS };
    } else if (open) {
      ranges.push(open);
      open = null;
    }
  }
  if (open) ranges.push(open);
  return ranges.filter((r) => r.end - r.start >= ask.durationMs);
}

const hhmm = (value: string, what: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new Error(`${what} must look like 09:00`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const Iso = (description: string) => Type.String({ description: `${description} ISO 8601 with its UTC offset, like 2026-10-06T10:00:00-07:00.` });

export function listEventsTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "list_events",
    label: "Check the calendar",
    description: "List events on the person's primary Google calendar between two times, optionally matching words.",
    parameters: Type.Object({
      from: Iso("Start of the window."),
      to: Iso("End of the window."),
      query: Type.Optional(Type.String({ description: "Words to match in titles, notes, places or attendees." })),
    }),
    risk: "read",
    source: "calendar",
    run: async ({ from, to, query }, { signal }) => {
      const list = await listEvents(deps, instant(from, "from"), instant(to, "to"), { signal, q: query, pageSize: LIST_EVENTS_MAX, pages: 1 });
      const events = list.items.filter((e) => e.status !== "cancelled");
      const { zone, range } = formatterFor(list.timeZone);
      const more = list.more ? `\n\nMore events follow the last one shown. Ask for a later or shorter window to see them.` : "";
      if (events.length === 0) return { content: `No events in that window (times in ${zone}).${more}`, details: { events: 0, more: list.more } };
      return { content: `Times in ${zone}.\n\n${events.map((e) => describeEvent(e, range)).join("\n\n")}${more}`, details: { events: events.length, more: list.more } };
    },
  });
}

export function findFreeTimeTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "find_free_time",
    label: "Find free time",
    description:
      "Find open stretches on the person's primary calendar at least a given length, inside working hours (09:00 to 18:00 on weekdays unless told otherwise), " +
      `in the calendar's own time zone. Searches at most ${FREE_TIME_MAX_DAYS} days.`,
    parameters: Type.Object({
      from: Iso("Start of the search."),
      to: Iso("End of the search."),
      minutes: Type.Integer({ minimum: 5, maximum: 24 * 60, description: "How long the free stretch must be." }),
      day_start: Type.Optional(Type.String({ description: 'Earliest local time, like "09:00".' })),
      day_end: Type.Optional(Type.String({ description: 'Latest local time, like "18:00".' })),
      weekends: Type.Optional(Type.Boolean({ description: "Include Saturdays and Sundays." })),
    }),
    risk: "read",
    run: async ({ from, to, minutes, day_start, day_end, weekends }, { signal }) => {
      const start = instant(from, "from");
      const asked = Math.min(instant(to, "to"), start + FREE_TIME_MAX_DAYS * 24 * 3600 * 1000);
      if (asked <= start) throw new Error("to must come after from");
      const list = await listEvents(deps, start, asked, { signal, pageSize: 250, pages: FREE_TIME_MAX_PAGES });
      const { zone, range, at } = formatterFor(list.timeZone);
      // Events past the last page are unread, so time after the last event
      // read cannot be called free: the search stops where reading stopped.
      const lastRead = list.items[list.items.length - 1];
      const end = list.more && lastRead ? Math.max(start, startMs(lastRead, zone)) : asked;
      const stopped = end < asked ? `\nThe calendar is too full to read past ${at(end)}; search from there for later times.` : "";
      const ranges = freeRanges(list.items, {
        from: start,
        to: end,
        durationMs: minutes * 60 * 1000,
        timeZone: zone,
        dayStart: hhmm(day_start ?? "09:00", "day_start"),
        dayEnd: hhmm(day_end ?? "18:00", "day_end"),
        weekdaysOnly: !weekends,
      });
      if (ranges.length === 0) return { content: `No free stretch of ${minutes} minutes in that window (times in ${zone}).${stopped}`, details: { ranges: 0 } };
      const shown = ranges.slice(0, 20);
      return {
        content: `Free, times in ${zone}:\n${shown.map((r) => `- ${range(r.start, r.end)} (from ${new Date(r.start).toISOString()})`).join("\n")}${ranges.length > shown.length ? `\nand ${ranges.length - shown.length} more` : ""}${stopped}`,
        details: { ranges: ranges.length },
      };
    },
  });
}

/** A Calendar event id from the model's call id, so a create that lands twice
 *  (a crash after Google accepted it) is one event: Google refuses the second
 *  insert of an id with 409. Event ids take base32hex characters, which hex is. */
export async function eventIdFor(callId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`codecast-assistant:${callId}`));
  return `cc${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

const Attendees = Type.Array(Type.String({ description: "An email address." }), { maxItems: 50 });

export function createEventTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "create_event",
    label: "Add to the calendar",
    description: "Create an event on the person's primary Google calendar. With attendees and notify, Google emails them an invitation.",
    parameters: Type.Object({
      title: Type.String(),
      start: Iso("When it starts."),
      end: Iso("When it ends."),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      attendees: Type.Optional(Attendees),
      notify: Type.Optional(Type.Boolean({ description: "Email the attendees an invitation. Off by default." })),
    }),
    risk: "write",
    run: async ({ title, start, end, description, location, attendees, notify }, { callId, signal }) => {
      if (instant(end, "end") <= instant(start, "start")) throw new Error("end must come after start");
      const id = await eventIdFor(callId);
      let event: CalendarEvent;
      try {
        event = await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, `${CALENDAR_API}/events`, {
          method: "POST",
          query: { sendUpdates: notify ? "all" : "none" },
          body: {
            id,
            summary: title,
            start: { dateTime: start },
            end: { dateTime: end },
            ...(description ? { description } : {}),
            ...(location ? { location } : {}),
            ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
          },
        }, signal);
      } catch (error) {
        // Already made by an earlier attempt of this same call.
        if (!(error instanceof Error && error.message.startsWith("Google answered 409"))) throw error;
        event = await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, `${CALENDAR_API}/events/${id}`, {}, signal);
      }
      return { content: `Added "${title}" (event ${event.id}).`, details: { event_id: event.id, link: event.htmlLink } };
    },
  });
}

export function updateEventTool(deps: GoogleDeps): Tool {
  return defineTool({
    name: "update_event",
    label: "Change an event",
    description: "Change an event on the person's primary Google calendar: its title, time, notes, place or attendees. Fields left out stay as they are.",
    parameters: Type.Object({
      event_id: Type.String(),
      title: Type.Optional(Type.String()),
      start: Type.Optional(Iso("New start.")),
      end: Type.Optional(Iso("New end.")),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      add_attendees: Type.Optional(Attendees),
      remove_attendees: Type.Optional(Attendees),
      notify: Type.Optional(Type.Boolean({ description: "Email the attendees about the change. Off by default." })),
    }),
    risk: "write",
    // The result names the event as Google holds it, a title the inviter may have written.
    source: "calendar",
    run: async ({ event_id, title, start, end, description, location, add_attendees, remove_attendees, notify }, { signal }) => {
      if (start) instant(start, "start");
      if (end) instant(end, "end");
      const url = `${CALENDAR_API}/events/${encodeURIComponent(event_id)}`;
      const patch: Record<string, unknown> = {
        ...(title !== undefined ? { summary: title } : {}),
        ...(start ? { start: { dateTime: start } } : {}),
        ...(end ? { end: { dateTime: end } } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
      };
      if (add_attendees?.length || remove_attendees?.length) {
        const current = await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, url, {}, signal);
        const drop = new Set((remove_attendees ?? []).map((a) => a.toLowerCase()));
        const kept = (current.attendees ?? []).filter((a) => !drop.has(a.email.toLowerCase()));
        const have = new Set(kept.map((a) => a.email.toLowerCase()));
        patch.attendees = [...kept, ...(add_attendees ?? []).filter((a) => !have.has(a.toLowerCase())).map((email) => ({ email }))];
      }
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change");
      const event = await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, url, {
        method: "PATCH",
        query: { sendUpdates: notify ? "all" : "none" },
        body: patch,
      }, signal);
      return { content: `Updated "${event.summary ?? event_id}" (event ${event.id}).`, details: { event_id: event.id } };
    },
  });
}

/** The Calendar tools, when the connection allows calendar events. */
export function calendarTools(deps: GoogleDeps): Tool[] {
  return [listEventsTool(deps), findFreeTimeTool(deps), createEventTool(deps), updateEventTool(deps)];
}
