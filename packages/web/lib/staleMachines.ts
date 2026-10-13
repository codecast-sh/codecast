/**
 * Which machines Settings > Machines offers to clean up.
 *
 * Kept pure, and out of the page, so the rule is testable. The server has the
 * final word on each removal (devices.performRemoveDevices refuses an online
 * machine); this only decides what the page offers.
 */
import { machineOutOfService, type CloudHostReport } from "@codecast/shared/contracts";

export { STALE_MACHINE_MS } from "@codecast/shared/contracts";

export type RemovableMachine = {
  device_id: string;
  online: boolean;
  last_seen: number;
  is_remote?: boolean;
  platform?: string;
  cloud_host?: CloudHostReport | null;
};

/** An online machine lists itself again on its next heartbeat, so removing it
 *  would read as a removal that did not stick. */
export function canRemoveMachine(d: RemovableMachine): boolean {
  return !d.online;
}

/**
 * The cleanup group: removable and out of service (machineOutOfService, the
 * same rule that keeps a machine out of the pickers): gone quiet, or a cloud
 * host whose instance is gone. A cloud box that is merely asleep is never
 * swept up with the dead laptops.
 */
export function isStaleMachine<T extends RemovableMachine>(d: T, now: number, roster: T[] = [d]): boolean {
  return canRemoveMachine(d) && machineOutOfService(d, roster, now);
}

export function splitStaleMachines<T extends RemovableMachine>(devices: T[], now: number): { current: T[]; stale: T[] } {
  const current: T[] = [];
  const stale: T[] = [];
  for (const d of devices) (isStaleMachine(d, now, devices) ? stale : current).push(d);
  return { current, stale };
}
