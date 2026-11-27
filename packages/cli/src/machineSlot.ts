/**
 * Named slots on this machine: at most a few holders of one name at once (its
 * cap in machineCaps.ts MACHINE_SLOTS), and none while the machine is short of
 * memory. Each place is a lock held by a live pid (lockFile.ts acquireFileSlot),
 * so a holder that died frees its place on the next try, and a waiter says so
 * in the slot's waiting/ directory for `cast slot ls`. Memory is the machine's
 * own pressure (watcherMemory.ts underPressure: the kernel's level, or swap
 * filling while little is available), never a count of processes: one checked
 * codecast worktree alone holds about 15 GB of typecheck watchers.
 *
 * Callers: a flow station's machine_slot= (workflow/stationSlot.ts) and
 * `cast slot run` (slotCommand.ts).
 */

import * as os from "node:os";
import { acquireFileSlot, listFileSlots, type SlotEntry } from "./lockFile.js";
import { codecastPath } from "./codecastDir.js";
import { MACHINE_SLOTS, machineCap, type MachineCapKey } from "./machineCaps.js";
import { machineMemoryProbe, underPressure } from "./watcherMemory.js";

export const machineSlotDir = (name: string): string => codecastPath("slots", name);

/** Why `name` is not a slot of this machine, or null when it is one. */
export function machineSlotProblem(name: string): string | null {
  return (MACHINE_SLOTS as string[]).includes(name) ? null : `${name} names no machine slot; the slots: ${MACHINE_SLOTS.join(", ")}`;
}

/** How often a waiter reads the machine's memory again (each read is a vm_stat and a sysctl). */
const PRESSURE_RECHECK_MS = 10_000;

export type SlotTaken = { release: () => void } | { release: null; why: string };

/**
 * Take a place in slot `name`, waiting up to `waitMs` (forever when unset).
 * `onWait` hears, once, why it waits; a wait that runs out comes back with
 * why instead of a release. The place is also given back when the process
 * exits or takes a signal.
 */
export async function takeMachineSlot(name: string, opts: { waitMs?: number; what: string; onWait?: (why: string) => void }): Promise<SlotTaken> {
  const cap = machineCap(name as MachineCapKey);
  const taken = (verb: string) => `all ${cap} ${name} slots on this machine ${verb} taken`;
  let pressure = false;
  let checkedAt = -Infinity;
  const ready = () => {
    if (Date.now() - checkedAt >= PRESSURE_RECHECK_MS) {
      checkedAt = Date.now();
      const memory = machineMemoryProbe.read();
      pressure = !!memory && underPressure(memory, os.totalmem());
    }
    return !pressure;
  };
  try {
    const release = await acquireFileSlot(machineSlotDir(name), cap, {
      waitMs: opts.waitMs,
      ready,
      describe: `${name} slots`,
      what: opts.what,
      onWait: () => opts.onWait?.(pressure ? "the machine is short of memory" : taken("are")),
    });
    return { release };
  } catch (err) {
    const message = (err as Error).message;
    return { release: null, why: pressure ? "the machine stayed short of memory" : /are taken/.test(message) ? taken("stayed") : message };
  }
}

/** Every slot of this machine with its cap, its holders and its waiters, oldest first. */
export function listMachineSlots(): Array<{ name: string; cap: number; running: SlotEntry[]; waiting: SlotEntry[] }> {
  return MACHINE_SLOTS.map((name) => {
    const slots = listFileSlots(machineSlotDir(name));
    return { name, cap: machineCap(name), running: slots.holding, waiting: slots.waiting };
  });
}
