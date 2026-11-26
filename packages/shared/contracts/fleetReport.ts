// The input of a fleet diff (fleetDiff.ts): what each machine reports. Types
// only, so this module costs nothing at runtime; fleetDiff.ts re-exports them.

/**
 * What a machine says it has.
 *
 * Typed as `unknown` on purpose. This arrives as JSON parsed from a report sent
 * by another machine, possibly written by an older binary, so `Inventory` here
 * would be a promise the wire cannot keep. Every field is validated below, and
 * a real `Inventory` satisfies this shape unchanged.
 */
export interface ReportedInventory {
  items?: unknown;
  marketplaces?: unknown;
}

/**
 * One machine's report.
 *
 * `inventory` absent (undefined, null, or a payload we cannot read) means this
 * device has told us nothing — a genuinely different fact from a device that
 * reported an EMPTY inventory, which is a machine that really has nothing
 * installed. The first produces `unknown` cells and does not count towards
 * agreement; the second counts fully and makes every row "absent here".
 *
 * A device may legitimately appear more than once: the server stores one report
 * per (device, client, project scope), so a caller handing us raw rows will pass
 * several for one machine. They are folded into a single column rather than
 * deduplicated, so nothing a machine reported is lost.
 */
export interface DeviceReport {
  deviceId: string;
  deviceLabel?: string;
  inventory?: ReportedInventory | null;
  /** Column metadata — see `FleetDevice`. Carried through, never reasoned about. */
  reportedAt?: number;
  lastError?: string;
  entryCount?: number;
}
