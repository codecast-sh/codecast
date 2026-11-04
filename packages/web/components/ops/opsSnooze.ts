// Snoozing what the Ops home lists. A watch is muted on the watch itself
// (metrics.updateWatch muted_until), so the whole team stops being paged by
// it. An issue, a replay or a source is snoozed for the person who pressed it
// (clientState.ui.ops_snoozes, stamped, so it follows them to every device).
// Either way a snoozed item comes back early when it gets worse: its state
// changes (new to escalating, regressed), or, snoozed until it changes, an issue
// doubles its events. Pure: no React, no store.
import type { AttentionItem, AttentionState } from "./opsHomeModel";

const HOUR = 3600_000;

export type OpsSnooze = {
  /** When it comes back; null for "until it changes". */
  until: number | null;
  /** The item's state when snoozed: any other state brings it back. */
  state: AttentionState;
  /** Its volume when snoozed (an issue's events), for "until it changes". */
  volume: number;
  at: number;
};

export type OpsSnoozes = Record<string, OpsSnooze>;

export type SnoozeChoice = { key: string; label: string; ms: number | null };

/** The windows a row offers, by kind. A watch's mute needs an end, so it has no "until it changes". */
export function snoozeChoices(kind: AttentionItem["kind"]): SnoozeChoice[] {
  const h1 = { key: "1h", label: "1 hour", ms: HOUR };
  const d1 = { key: "24h", label: "24 hours", ms: 24 * HOUR };
  const d7 = { key: "7d", label: "7 days", ms: 7 * 24 * HOUR };
  if (kind === "watch") return [h1, d1, d7];
  if (kind === "issue") return [h1, d1, { key: "change", label: "Until it gets worse", ms: null }];
  return [d1, d7];
}

/** An issue snoozed until it changes comes back once its events double (and grow by at least ten). */
function grewPast(volume: number, at: number): boolean {
  return volume >= Math.max(at * 2, at + 10);
}

/** Whether an item is snoozed now: a muted watch, or a person's snooze it has not outgrown. */
export function isSnoozed(item: AttentionItem, snoozes: OpsSnoozes | null | undefined, now: number): boolean {
  if (item.kind === "watch") return !!item.watch.muted_until && item.watch.muted_until > now;
  const rec = snoozes?.[item.key];
  if (!rec) return false;
  if (rec.until !== null && now >= rec.until) return false;
  // A snooze taken under an older name for the same state (spiking, a reader's watch error) still holds.
  const was = rec.state === ("spiking" as string) ? "escalating" : item.kind === "reader" && rec.state === "erroring" ? "reader" : rec.state;
  if (was !== item.state) return false;
  if (rec.until === null && item.kind === "issue" && Number.isFinite(item.volume) && grewPast(item.volume, rec.volume)) return false;
  return true;
}

/** When a snoozed item comes back, as a time; null for "until it gets worse". */
export function snoozedUntil(item: AttentionItem, snoozes: OpsSnoozes | null | undefined): number | null {
  if (item.kind === "watch") return item.watch.muted_until ?? null;
  return snoozes?.[item.key]?.until ?? null;
}

export function splitSnoozed<T extends AttentionItem>(items: T[], snoozes: OpsSnoozes | null | undefined, now: number): { live: T[]; snoozed: T[] } {
  const live: T[] = [];
  const snoozed: T[] = [];
  for (const it of items) (isSnoozed(it, snoozes, now) ? snoozed : live).push(it);
  return { live, snoozed };
}

/**
 * The person's snoozes with one added (or, with `choice` null, removed), and
 * every one that has run out dropped, so the bag never grows past what is live.
 */
export function nextSnoozes(current: OpsSnoozes | null | undefined, item: AttentionItem, choice: SnoozeChoice | null, now: number): OpsSnoozes {
  const out: OpsSnoozes = {};
  for (const [k, v] of Object.entries(current ?? {})) if (v.until === null || v.until > now) out[k] = v;
  if (choice) out[item.key] = { until: choice.ms === null ? null : now + choice.ms, state: item.state, volume: Number.isFinite(item.volume) ? item.volume : 0, at: now };
  else delete out[item.key];
  return out;
}
