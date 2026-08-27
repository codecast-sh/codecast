import { Calendar } from "lucide-react";

// The one date chip. The doc editor's dateMention node view and the read-mode
// markdown pipeline (`@[<label> date:<iso>]` via EntityAwareLink) both render
// this, so a date looks identical while a doc is edited, read, or quoted.
// Styled with tokens only — no editor.css dependency, so it works on any
// markdown surface (chat, comments, conversation prose).

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

export function DatePill({ iso, label: storedLabel }: { iso: string; label?: string | null }) {
  const { label, resolved } = resolveDateDisplay(iso, storedLabel);
  return (
    <span className="inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-0.5 rounded-full align-middle bg-sol-orange/10 border border-sol-orange/20">
      <Calendar className="w-3.5 h-3.5 flex-shrink-0 text-sol-orange" />
      <span className="text-[13px] font-medium leading-[1.3] text-sol-text">{label}</span>
      {resolved && (
        <span className="text-[11px] font-mono text-sol-text-dim opacity-80">{resolved}</span>
      )}
    </span>
  );
}
