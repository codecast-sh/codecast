// What a date mention (`@[<label> date:<iso>]`) reads as: its label, kept
// current when it was relative ("Today"), and the weekday and date it names.
// Pure, so the web chip and the phone agree.

const RELATIVE_DATE_LABELS = new Set([
  "today", "yesterday", "tomorrow",
  "this week", "last week", "next week",
  "this month", "last month", "next month",
]);

function recomputeRelativeLabel(iso: string): string | null {
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const target = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  return null;
}

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export function resolveDateDisplay(iso: string, storedLabel?: string | null): {
  label: string;
  resolved: string;
} {
  const stored = storedLabel || iso;
  // A relative label ("Today") stored at write time goes stale — recompute it
  // against the current date, falling back to the ISO date once it's neither.
  const isRelative = RELATIVE_DATE_LABELS.has(String(stored).toLowerCase());
  const label = isRelative ? (recomputeRelativeLabel(iso) ?? iso) : stored;

  let resolved = "";
  const parts = iso.split("-");
  if (parts.length === 3) {
    const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    if (!isNaN(d.getTime())) {
      resolved = `${DAYS[d.getDay()]}, ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
  }
  return { label, resolved: resolved !== label ? resolved : "" };
}
