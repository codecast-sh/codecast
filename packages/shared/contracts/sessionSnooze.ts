export const SESSION_SNOOZE_CHOICES = [
  { key: "1", label: "1 day", days: 1 },
  { key: "3", label: "3 days", days: 3 },
  { key: "w", label: "1 week", days: 7 },
  { key: "m", label: "1 month", days: 0 },
] as const;

export type SessionSnoozeKey = (typeof SESSION_SNOOZE_CHOICES)[number]["key"];

export function sessionSnoozeUntil(key: SessionSnoozeKey, now = Date.now()): number {
  const choice = SESSION_SNOOZE_CHOICES.find((item) => item.key === key);
  if (!choice) throw new Error("Invalid snooze duration");
  const date = new Date(now);
  if (choice.days) date.setDate(date.getDate() + choice.days);
  else {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, lastDay));
  }
  return date.getTime();
}
