/**
 * Which machines Settings > Machines offers to clean up.
 *
 * Kept pure, and out of the page, so the rule is testable. The server has the
 * final word on each removal (devices.performRemoveDevices refuses an online
 * machine); this only decides what the page offers.
 */
import { deviceWakesOnUse } from "@codecast/shared/contracts";

export type RemovableMachine = {
  device_id: string;
  online: boolean;
  last_seen: number;
  is_remote?: boolean;
  platform?: string;
};

/**
 * Quiet for this long and a machine moves to the cleanup group. A day, not
 * weeks: the clutter in a real roster is short lived containers that each mint
 * a device id and die within hours, while a laptop closed overnight is back
 * inside the window and keeps its full card.
 */
export const STALE_MACHINE_MS = 24 * 60 * 60 * 1000;

/** An online machine lists itself again on its next heartbeat, so removing it
 *  would read as a removal that did not stick. */
export function canRemoveMachine(d: RemovableMachine): boolean {
  return !d.online;
}

/**
 * Gone quiet, as opposed to asleep. A cloud box that wakes on use is offline
 * whenever it is idle, so a long silence there says "unused", never "gone",
 * and a bulk cleanup must not sweep it up with the dead laptops.
 */
export function isStaleMachine(d: RemovableMachine, now: number): boolean {
  return canRemoveMachine(d) && !deviceWakesOnUse(d) && now - d.last_seen >= STALE_MACHINE_MS;
}

export function splitStaleMachines<T extends RemovableMachine>(devices: T[], now: number): { current: T[]; stale: T[] } {
  const current: T[] = [];
  const stale: T[] = [];
  for (const d of devices) (isStaleMachine(d, now) ? stale : current).push(d);
  return { current, stale };
}
