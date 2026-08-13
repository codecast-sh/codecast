// The fleet diff itself now lives in `@codecast/shared/contracts/fleetDiff`.
//
// It moved because three runtimes have to render the same verdict — the daemon
// (`cast cap status`), the browser (`/capabilities`) and Convex (the stored
// summary) — and only one of them can import a CLI module. While the algorithm
// lived here the browser could not reach it, so it grew a second model of the
// same grid with a different vocabulary and two bugs the shared model does not
// have: a single `scope` where scopes stack, and a boolean verdict that cannot
// say "only one machine has reported". A shared module makes that impossible
// rather than merely discouraged.
//
// This file stays as the CLI's spelling of it, so every caller and every test
// here keeps importing `./fleetDiff.js` unchanged. The names are listed rather
// than splatted: `@codecast/shared/contracts` is the whole contract barrel, and
// `export *` from it would quietly make this module a second front door to
// every unrelated enum in the repo.
export {
  buildFleetDiff,
  capabilityIdentity,
  fleetRowKey,
  type CellStatus,
  type DeviceReport,
  type FleetDevice,
  type FleetDiff,
  type FleetDiffCell,
  type FleetDiffRow,
  type FleetDiffSummary,
  type FleetRowKind,
  type Pin,
  type PinKind,
  type ReportedInventory,
  type RowStatus,
} from "@codecast/shared/contracts";

import type { InventoryItem } from "./inventory.js";
import type { FleetRowKind, ObservedScope } from "@codecast/shared/contracts";

/**
 * The seam, checked at build time.
 *
 * The diff reads reports as `unknown` because they arrive over the wire from
 * machines running older binaries, so nothing inside it can catch THIS machine's
 * reader drifting away from the vocabulary the diff ranks. A new inventory kind
 * with no rank is dropped in silence, and that silence looks exactly like a
 * machine that does not have the thing. These two lines fail the build instead.
 */
type Conforms<T extends true> = T;
type _KindsAreRanked = Conforms<InventoryItem["kind"] extends FleetRowKind ? true : false>;
type _ScopesAreObserved = Conforms<InventoryItem["scope"] extends ObservedScope ? true : false>;
