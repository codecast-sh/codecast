// Daily notes and template expansion — the two small Obsidian core plugins
// that turn a vault into a journal.
//
// Pure functions only: path shapes, date math, and placeholder substitution.
// The store does the file creation; this module decides WHAT to create.

/** Where daily notes live and how they're named. Kept deliberately small —
 *  Obsidian's own settings are a folder, a date format, and a template. */
export interface DailyNoteSettings {
  /** Vault-relative folder ("" = vault root). */
  folder: string;
  /** Date format. Only the tokens below are supported; anything else is
   *  literal, which is why this is a format string and not a strftime clone. */
  format: string;
  /** Vault-relative path of a template note, if any. */
  template?: string;
}

export const DEFAULT_DAILY_SETTINGS: DailyNoteSettings = {
  folder: "Daily",
  format: "YYYY-MM-DD",
  template: "",
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Format a date with the token subset Obsidian users actually type.
 *  Longest tokens first so YYYY isn't eaten by YY. */
export function formatDate(date: Date, format: string): string {
  const tokens: [string, string][] = [
    ["YYYY", String(date.getFullYear())],
    ["MMMM", MONTHS[date.getMonth()]],
    ["dddd", DAYS[date.getDay()]],
    ["MMM", MONTHS[date.getMonth()].slice(0, 3)],
    ["ddd", DAYS[date.getDay()].slice(0, 3)],
    ["YY", pad(date.getFullYear() % 100)],
    ["MM", pad(date.getMonth() + 1)],
    ["DD", pad(date.getDate())],
    ["HH", pad(date.getHours())],
    ["mm", pad(date.getMinutes())],
    ["ss", pad(date.getSeconds())],
  ];
  // Single pass with one regex so a replacement's own text can never be
  // re-substituted (a month named "May" containing no tokens is luck, not a
  // guarantee — "March" would otherwise be safe but "dddd" output could not).
  const pattern = new RegExp(tokens.map(([t]) => t).join("|"), "g");
  const lookup = new Map(tokens);
  return format.replace(pattern, (m) => lookup.get(m) ?? m);
}

/** Vault-relative path for a given day's note. */
export function dailyNotePath(date: Date, settings: DailyNoteSettings): string {
  const name = `${formatDate(date, settings.format)}.md`;
  return settings.folder ? `${settings.folder}/${name}` : name;
}

/** Shift a date by whole days, preserving local wall-clock semantics
 *  (setDate handles month/year rollover and DST for us). */
export function shiftDays(date: Date, delta: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + delta);
  return next;
}

/** Given the daily notes that exist, find the one immediately before/after a
 *  date. Used by "previous/next daily note", which in Obsidian jumps to the
 *  nearest EXISTING note rather than an empty adjacent day. */
export function adjacentDailyNote(
  paths: string[],
  date: Date,
  settings: DailyNoteSettings,
  direction: -1 | 1,
): string | null {
  const current = dailyNotePath(date, settings);
  const prefix = settings.folder ? `${settings.folder}/` : "";
  const candidates = paths
    .filter((p) => p.startsWith(prefix) && p.endsWith(".md") && !p.slice(prefix.length).includes("/"))
    .sort();
  if (!candidates.length) return null;
  if (direction === 1) return candidates.find((p) => p > current) ?? null;
  let prev: string | null = null;
  for (const p of candidates) {
    if (p >= current) break;
    prev = p;
  }
  return prev;
}

/** Expand a template body. Supported placeholders mirror Obsidian's core
 *  Templates plugin: {{title}}, {{date}}, {{time}}, and {{date:FORMAT}} /
 *  {{time:FORMAT}} for a custom shape. Unknown placeholders are left intact
 *  rather than blanked — a template that prints "{{unknown}}" is debuggable;
 *  one that silently drops content is not. */
export function expandTemplate(
  body: string,
  vars: { title: string; date?: Date; dateFormat?: string; timeFormat?: string },
): string {
  const now = vars.date ?? new Date();
  const dateFmt = vars.dateFormat ?? "YYYY-MM-DD";
  const timeFmt = vars.timeFormat ?? "HH:mm";
  return body.replace(/\{\{(title|date|time)(?::([^}]+))?\}\}/g, (_m, kind: string, fmt?: string) => {
    if (kind === "title") return vars.title;
    if (kind === "date") return formatDate(now, fmt || dateFmt);
    return formatDate(now, fmt || timeFmt);
  });
}
