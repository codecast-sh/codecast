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
