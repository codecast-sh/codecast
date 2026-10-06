// How often a check or a routine runs, in words. A leaf with no imports, so
// the public pages (the pricing page's assistant plans) and the org's
// staffing pane say a cadence the same way.

export const CHECK_CADENCES: ReadonlyArray<{ ms: number; label: string }> = [
  { ms: 6 * 3_600_000, label: "every 6 hours" },
  { ms: 12 * 3_600_000, label: "twice a day" },
  { ms: 86_400_000, label: "every day" },
  { ms: 2 * 86_400_000, label: "every 2 days" },
  { ms: 7 * 86_400_000, label: "every week" },
  { ms: 14 * 86_400_000, label: "every 2 weeks" },
];

/** The cadence's label, or the nearest whole unit for one set elsewhere. */
export function cadenceLabel(ms: number | null | undefined): string {
  if (!ms) return "no schedule";
  const known = CHECK_CADENCES.find((c) => c.ms === ms);
  if (known) return known.label;
  const days = ms / 86_400_000;
  if (days >= 1 && Number.isInteger(days)) return `every ${days} days`;
  const hours = Math.round(ms / 3_600_000);
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}
