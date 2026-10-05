// Google Calendar as a Calendar (calendar.ts) for the hosted assistant (plan
// pl-840): the calendar tools' verbs over the Calendar REST API with the
// owner's token (google.ts), on their primary calendar. Paging, the event
// scope and Google's answer to a repeated insert live here; the tools and
// their rules live in calendar.ts.
import { CALENDAR_EVENTS_SCOPE } from "../../googleOAuth";
import { googleCall, type GoogleDeps } from "./google";
import type { Calendar, CalendarEvent } from "./calendar";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary";

type EventList = { items?: CalendarEvent[]; timeZone?: string; nextPageToken?: string };

const eventUrl = (id: string) => `${CALENDAR_API}/events/${encodeURIComponent(id)}`;
const sendUpdates = (notify: boolean) => ({ sendUpdates: notify ? "all" : "none" });

/** The owner's primary Google calendar as a Calendar. Nothing is called until a verb runs. */
export function googleCalendar(deps: GoogleDeps): Calendar {
  return {
    async events(from, to, opts, signal) {
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
        }, signal);
        items.push(...(list.items ?? []));
        timeZone ??= list.timeZone;
        pageToken = list.nextPageToken;
        if (!pageToken) break;
      }
      return { items, timeZone, more: !!pageToken };
    },

    event: (id, signal) => googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, eventUrl(id), {}, signal),

    async insert(event, notify, signal) {
      try {
        return await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, `${CALENDAR_API}/events`, {
          method: "POST",
          query: sendUpdates(notify),
          body: event,
        }, signal);
      } catch (error) {
        // Google refuses a second insert of an id with 409: an earlier
        // attempt of this same call already made the event.
        if (!(error instanceof Error && error.message.startsWith("Google answered 409"))) throw error;
        return await googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, eventUrl(event.id), {}, signal);
      }
    },

    patch: (id, patch, notify, signal) =>
      googleCall<CalendarEvent>(deps, CALENDAR_EVENTS_SCOPE, eventUrl(id), { method: "PATCH", query: sendUpdates(notify), body: patch }, signal),
  };
}
