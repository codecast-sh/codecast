import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";

export function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Walks an already ordered list and cuts it wherever the calendar day changes. */
export function groupByDay<T extends { ts: number }>(list: T[], now: number): { label: string; events: T[] }[] {
  const out: { label: string; events: T[] }[] = [];
  for (const e of list) {
    const label = dayLabel(e.ts, now);
    const group = out[out.length - 1];
    if (group && group.label === label) group.events.push(e);
    else out.push({ label, events: [e] });
  }
  return out;
}

export const STATUS_COLOR: Record<string, string> = {
  backlog: "text-sol-text-dim",
  open: "text-sol-blue",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-sol-text-dim",
};

export const STATUS_ICON: Record<string, typeof Circle> = {
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
};
