export const PRESENCE_FRESH_MS = 150_000;
export const INPUT_ACTIVE_MS = 3 * 60_000;

export type PresenceRow = {
  last_seen: number;
  last_input_at: number;
};

export function isDesktopActivePresence(
  presence: PresenceRow | null | undefined,
  now: number,
): boolean {
  if (!presence) return false;
  return (
    now - presence.last_seen < PRESENCE_FRESH_MS &&
    now - presence.last_input_at < INPUT_ACTIVE_MS
  );
}

export type MachineDevice = {
  last_seen: number;
  last_input_at?: number;
  is_remote?: boolean;
};

export function isMachineActivePresence(
  devices: MachineDevice[],
  now: number,
): boolean {
  return devices.some(
    (device) =>
      !device.is_remote &&
      device.last_input_at !== undefined &&
      now - device.last_seen < PRESENCE_FRESH_MS &&
      now - device.last_input_at < INPUT_ACTIVE_MS,
  );
}

// How stale a stored last_seen may get before a report refreshes it. Well
// inside PRESENCE_FRESH_MS: a refresh at most this late, plus one missed 30s
// heartbeat, still lands before the row reads as gone.
export const PRESENCE_SEEN_REFRESH_MS = 60_000;
// How far input must move forward before it is written again. Small against
// INPUT_ACTIVE_MS, so "active" can end at most this much early, and it ends
// toward away, the direction every presence reader treats as safe.
export const PRESENCE_INPUT_STEP_MS = 30_000;

/**
 * The fields one presence report should write, or {} when nothing a reader
 * can see has changed. Every write to a user_presence row makes each query
 * that read the row run again, and the team roster reads every member's row
 * for every open tab, so an unconditional write on each 10 to 30 s report
 * re-ran the roster at the fleet's report rate (2.1 writes a second on
 * 2026-10-01) while it returned byte identical results. Same rule as the
 * daemon heartbeat's user doc throttle (users.daemonHeartbeat).
 */
export function presenceReportPatch(
  existing: (PresenceRow & { focused?: boolean }) | null | undefined,
  report: { focused: boolean; lastInputAt: number },
  now: number,
): { last_seen?: number; last_input_at?: number; focused?: boolean; updated_at?: number } {
  if (!existing) return { last_seen: now, last_input_at: report.lastInputAt, focused: report.focused, updated_at: now };
  const patch: { last_seen?: number; last_input_at?: number; focused?: boolean; updated_at?: number } = {};
  if (report.lastInputAt - existing.last_input_at >= PRESENCE_INPUT_STEP_MS) patch.last_input_at = report.lastInputAt;
  if (existing.focused !== report.focused) patch.focused = report.focused;
  if (now - existing.last_seen >= PRESENCE_SEEN_REFRESH_MS || Object.keys(patch).length > 0) patch.last_seen = now;
  if (Object.keys(patch).length > 0) patch.updated_at = now;
  return patch;
}
