// A hosted assistant's calendar tools: list events, find free
// time, create and update events on the person's primary calendar. The tools
// are written against a Calendar, the few verbs any calendar engine offers,
// with events in Google Calendar's event shape (the shape the family's
// calendars already sync in). whiskEngine.ts is the Calendar: the apps reach
// calendars only through Whisk, which emails guests about every change, so a
// call that would reach guests must say notify.
//
// Listing and finding are risk "read"; creating and updating are "write" and
// pass the gate. Event titles and descriptions are written by whoever sent
// the invitation, so every tool that returns them declares source "calendar".
import { defineTool, Type, type Tool } from "@platform/agent";
import { dayBounds, wallClockAt } from "./zone";
import { callKey, ruleAddresses } from "./mail";
import { NEVER, NO_ONE, type AllowScopes } from "./rules";

/** The longest window find_free_time searches. */
export const FREE_TIME_MAX_DAYS = 14;
const SLOT_STEP_MS = 15 * 60 * 1000;

/** An event edge: `dateTime` for a timed event, `date` for an all-day one.
 *  A patch clears `date` with null when it makes an all-day edge timed, since
 *  a patch merges into the stored edge rather than replacing it. */
type EventTime = { dateTime?: string; date?: string | null; timeZone?: string };
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
/** Events read for a window, and whether the calendar holds more past the
 *  last one read. `seen` is the span the engine can read at all, when it
 *  holds a copy of the calendar for a limited span: time outside it is
 *  unknown, never free. */
export type EventRead = { items: CalendarEvent[]; timeZone?: string; more: boolean; seen?: { from: number; to: number } };

/** Where a read window leaves the span the calendar can be read for: the
 *  part inside it, and the sentence that says what is unknown. A window
 *  wholly outside has no part inside (`to <= from`). */
function withinSeen(from: number, to: number, seen: EventRead["seen"], at: (ms: number) => string) {
  if (!seen || (from >= seen.from && to <= seen.to)) return { from, to, note: "" };
  return {
    from: Math.max(from, seen.from),
    to: Math.min(to, seen.to),
    note: `The calendar can be read only from ${at(seen.from)} to ${at(seen.to)}. Its events outside that span are unknown, so that time is not free.`,
  };
}

/** The verbs the calendar tools need from a calendar engine, on the owner's primary calendar. */
export interface Calendar {
  /** Events in a window (single instances of repeating ones), oldest first,
   *  reading up to `pages` pages of `pageSize`. */
  events(from: number, to: number, opts: { q?: string; pageSize: number; pages: number }, signal?: AbortSignal): Promise<EventRead>;
  event(id: string, signal?: AbortSignal): Promise<CalendarEvent>;
  /** Creates the event under its own `id`, a key from the call. A create
   *  that already landed under that key (an earlier attempt of the same call)
   *  returns that event. Refuses guests without `notify` when the engine
   *  always emails them. */
  insert(event: Partial<CalendarEvent> & { id: string }, notify: boolean, signal?: AbortSignal): Promise<CalendarEvent>;
  /** Changes only the fields given. Refuses a change that would email guests
   *  without `notify`, when the engine always does. */
  patch(id: string, patch: Record<string, unknown>, notify: boolean, signal?: AbortSignal): Promise<CalendarEvent>;
}

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

export function listEventsTool(calendar: Calendar): Tool {
  return defineTool({
    name: "list_events",
    label: "Check the calendar",
    description: "List events on the person's primary calendar between two times, optionally matching words.",
    parameters: Type.Object({
      from: Iso("Start of the window."),
      to: Iso("End of the window."),
      query: Type.Optional(Type.String({ description: "Words to match in titles, notes, places or attendees." })),
    }),
    risk: "read",
    source: "calendar",
    run: async ({ from, to, query }, { signal }) => {
      const asked = { from: instant(from, "from"), to: instant(to, "to") };
      const list = await calendar.events(asked.from, asked.to, { q: query, pageSize: LIST_EVENTS_MAX, pages: 1 }, signal);
      const events = list.items.filter((e) => e.status !== "cancelled");
      const { zone, range, at } = formatterFor(list.timeZone);
      const seen = withinSeen(asked.from, asked.to, list.seen, at);
      if (seen.to <= seen.from) return { content: seen.note, details: { events: 0, more: false, unseen: true } };
      const more = (list.more ? `\n\nMore events follow the last one shown. Ask for a later or shorter window to see them.` : "") + (seen.note ? `\n\n${seen.note}` : "");
      if (events.length === 0) return { content: `No events in that window (times in ${zone}).${more}`, details: { events: 0, more: list.more } };
      return { content: `Times in ${zone}.\n\n${events.map((e) => describeEvent(e, range)).join("\n\n")}${more}`, details: { events: events.length, more: list.more } };
    },
  });
}

export function findFreeTimeTool(calendar: Calendar): Tool {
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
      const list = await calendar.events(start, asked, { pageSize: 250, pages: FREE_TIME_MAX_PAGES }, signal);
      const { zone, range, at } = formatterFor(list.timeZone);
      // Only time the calendar can be read for can be called free.
      const seen = withinSeen(start, asked, list.seen, at);
      if (seen.to <= seen.from) return { content: seen.note, details: { ranges: 0, unseen: true } };
      // Events past the last page are unread, so time after the last event
      // read cannot be called free: the search stops where reading stopped.
      const lastRead = list.items[list.items.length - 1];
      const end = list.more && lastRead ? Math.max(seen.from, Math.min(seen.to, startMs(lastRead, zone))) : seen.to;
      const stopped =
        (end < seen.to ? `\nThe calendar is too full to read past ${at(end)}; search from there for later times.` : "") + (seen.note ? `\n${seen.note}` : "");
      const ranges = freeRanges(list.items, {
        from: seen.from,
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

const Attendees = Type.Array(Type.String({ description: "An email address." }), { maxItems: 50 });

export function createEventTool(calendar: Calendar): Tool {
  return defineTool({
    name: "create_event",
    label: "Add to the calendar",
    description: "Create an event on the person's primary calendar. Guests are always emailed an invitation, so an event with attendees needs notify set to true.",
    parameters: Type.Object({
      title: Type.String(),
      start: Iso("When it starts."),
      end: Iso("When it ends."),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      attendees: Type.Optional(Attendees),
      notify: Type.Optional(Type.Boolean({ description: "Email the attendees an invitation. Required for an event with attendees." })),
    }),
    risk: "write",
    run: async ({ title, start, end, description, location, attendees, notify }, { callId, signal }) => {
      if (instant(end, "end") <= instant(start, "start")) throw new Error("end must come after start");
      const event = await calendar.insert({
        id: await callKey(callId),
        summary: title,
        start: { dateTime: start },
        end: { dateTime: end },
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
      }, !!notify, signal);
      return { content: `Added "${title}" (event ${event.id}).`, details: { event_id: event.id, link: event.htmlLink } };
    },
  });
}

/** The new edges for an event whose start, end or both change. A new start
 *  alone moves the event and keeps its length; a new end alone keeps its
 *  start. Edges keep the event's own time zone, which a repeating event
 *  needs. An all-day event changes time only with both edges given. */
export function movedEdges(current: CalendarEvent, start: string | undefined, end: string | undefined): { start?: EventTime; end?: EventTime } {
  const edge = (dateTime: string, was: EventTime | undefined): EventTime => ({
    dateTime,
    ...(was?.date ? { date: null } : {}),
    ...(was?.timeZone ? { timeZone: was.timeZone } : {}),
  });
  const s = start !== undefined ? instant(start, "start") : undefined;
  const e = end !== undefined ? instant(end, "end") : undefined;
  if (s !== undefined && e !== undefined) {
    if (e <= s) throw new Error("end must come after start");
    return { start: edge(start!, current.start), end: edge(end!, current.end) };
  }
  if (!current.start?.dateTime || !current.end?.dateTime) {
    throw new Error("That is an all-day event: give both start and end to change its time");
  }
  const wasStart = Date.parse(current.start.dateTime);
  const wasEnd = Date.parse(current.end.dateTime);
  if (s !== undefined) return { start: edge(start!, current.start), end: edge(new Date(s + (wasEnd - wasStart)).toISOString(), current.end) };
  if (e! <= wasStart) throw new Error(`end must come after the event's start, ${current.start.dateTime}`);
  return { end: edge(end!, current.end) };
}

export function updateEventTool(calendar: Calendar): Tool {
  return defineTool({
    name: "update_event",
    label: "Change an event",
    description:
      "Change an event on the person's primary calendar: its title, time, notes, place or attendees. Fields left out stay as they are. " +
      "A new start alone moves the event and keeps its length; a new end alone keeps its start. An all-day event needs both. " +
      "Guests are emailed about any change, so changing an event with guests needs notify set to true.",
    parameters: Type.Object({
      event_id: Type.String(),
      title: Type.Optional(Type.String()),
      start: Type.Optional(Iso("New start.")),
      end: Type.Optional(Iso("New end.")),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      add_attendees: Type.Optional(Attendees),
      remove_attendees: Type.Optional(Attendees),
      notify: Type.Optional(Type.Boolean({ description: "Email the attendees about the change. Required for an event with guests." })),
    }),
    risk: "write",
    // The result names the event as the calendar holds it, a title the inviter may have written.
    source: "calendar",
    run: async ({ event_id, title, start, end, description, location, add_attendees, remove_attendees, notify }, { signal }) => {
      // Check the times before anything is read, so a malformed one fails alone.
      if (start !== undefined) instant(start, "start");
      if (end !== undefined) instant(end, "end");
      const retimed = start !== undefined || end !== undefined;
      const reattended = !!(add_attendees?.length || remove_attendees?.length);
      const current = retimed || reattended ? await calendar.event(event_id, signal) : undefined;
      const patch: Record<string, unknown> = {
        ...(title !== undefined ? { summary: title } : {}),
        ...(retimed ? movedEdges(current!, start, end) : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
      };
      if (reattended) {
        const drop = new Set((remove_attendees ?? []).map((a) => a.toLowerCase()));
        const kept = (current!.attendees ?? []).filter((a) => !drop.has(a.email.toLowerCase()));
        const have = new Set(kept.map((a) => a.email.toLowerCase()));
        patch.attendees = [...kept, ...(add_attendees ?? []).filter((a) => !have.has(a.toLowerCase())).map((email) => ({ email }))];
      }
      if (Object.keys(patch).length === 0) throw new Error("Nothing to change");
      const event = await calendar.patch(event_id, patch, !!notify, signal);
      return { content: `Updated "${event.summary ?? event_id}" (event ${event.id}).`, details: { event_id: event.id } };
    },
  });
}

/** The calendar tools over any Calendar. */
export function calendarTools(calendar: Calendar): Tool[] {
  return [listEventsTool(calendar), findFreeTimeTool(calendar), createEventTool(calendar), updateEventTool(calendar)];
}

/** How an Always allow narrows for each calendar tool (rules.ts): a rule
 *  covers exactly the guests a call adds, and never a call that emails them
 *  or drops one, since that changes what other people see and no match
 *  names it. */
export const CALENDAR_SCOPES: AllowScopes = {
  create_event: (input) => {
    if (input.notify) return NEVER;
    const guests = ruleAddresses("bare", input.attendees);
    if (guests === null) return NEVER;
    return guests
      ? { kind: "match", match: guests, covers: `Add events with ${guests} as the guests, without emailing them` }
      : { kind: "match", match: NO_ONE, covers: "Add events with no guests" };
  },
  update_event: (input) => {
    if (input.notify || (Array.isArray(input.remove_attendees) && input.remove_attendees.length > 0)) return NEVER;
    const added = ruleAddresses("bare", input.add_attendees);
    if (added === null) return NEVER;
    return added
      ? { kind: "match", match: added, covers: `Add ${added} to events, without emailing anyone` }
      : { kind: "match", match: NO_ONE, covers: "Change events without adding or removing anyone or emailing the guests" };
  },
};
