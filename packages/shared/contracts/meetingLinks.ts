// Meeting links a codecast bot can join (Zoom, Google Meet, Microsoft Teams,
// Webex, GoTo). One rule for the server, which refuses a link before a bot is
// paid for (convex meetingBots.ts), and the app, which offers a bot when a
// person pastes one (the Start huddle picker, the Calls page).

export type MeetingPlatform = "zoom" | "google_meet" | "microsoft_teams" | "webex" | "goto_meeting";

// The links a bot can join, by host. A link we cannot name is refused before
// a bot is paid for, with words that say which platforms work.
const PLATFORM_HOSTS: Array<[MeetingPlatform, RegExp]> = [
  ["zoom", /(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/],
  ["google_meet", /^meet\.google\.com$/],
  ["microsoft_teams", /^teams\.(microsoft|live)\.com$|^teams\.cloud\.microsoft$/],
  ["webex", /(^|\.)webex\.com$/],
  ["goto_meeting", /(^|\.)(gotomeeting|gotomeet)\.(com|me)$|^meet\.goto\.com$|^app\.goto\.com$/],
];

export const MEETING_PLATFORM_NAMES: Record<MeetingPlatform, string> = {
  zoom: "Zoom",
  google_meet: "Google Meet",
  microsoft_teams: "Microsoft Teams",
  webex: "Webex",
  goto_meeting: "GoTo Meeting",
};

/** The platform a meeting link belongs to, and the link cleaned up, or why
 *  no bot can join it. */
export function parseMeetingUrl(raw: string): { ok: true; url: string; platform: MeetingPlatform } | { ok: false; reason: string } {
  const text = (raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "That is not a meeting link." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "That is not a meeting link." };
  const host = u.hostname.toLowerCase();
  const hit = PLATFORM_HOSTS.find(([, re]) => re.test(host));
  if (!hit) {
    return { ok: false, reason: `A bot can join ${Object.values(MEETING_PLATFORM_NAMES).join(", ")} meetings.` };
  }
  if (hit[0] === "google_meet" && !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(u.pathname)) {
    return { ok: false, reason: "That Google Meet link has no meeting code." };
  }
  u.protocol = "https:";
  return { ok: true, url: u.toString(), platform: hit[0] };
}

/** A link that names a meeting, not just a platform's home page: what the
 *  app offers a bot for as someone types or pastes (a bare "zoom.us" is
 *  still on its way to being a link). */
export function meetingLinkIn(text: string): { url: string; platform: MeetingPlatform; name: string } | null {
  const t = (text ?? "").trim();
  if (!t || /\s/.test(t)) return null;
  const parsed = parseMeetingUrl(t);
  if (!parsed.ok) return null;
  const path = new URL(parsed.url).pathname;
  return path.length > 1 ? { url: parsed.url, platform: parsed.platform, name: MEETING_PLATFORM_NAMES[parsed.platform] } : null;
}
