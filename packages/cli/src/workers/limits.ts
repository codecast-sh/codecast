// The worker protocol's numeric limits, in a module of their own.
//
// protocol.ts is where the frame shape and its validators live, and every
// validator imports the payload type module it checks — so protocol.ts reaches
// eight `workers/*` type modules. ingestDeadline.ts needs one number from it,
// MAX_DEADLINE_MS, and syncService.ts needs ingestDeadline: that one constant
// was pulling the whole worker payload vocabulary onto the CLI's boot graph
// (bench/bootGraph.guard.test.ts). Constants have no dependencies, so they sit
// here and protocol.ts re-exports them for its own importers.

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_INFLIGHT = 4;
export const MAX_QUEUE = 32;
export const MAX_DEADLINE_MS = 60_000;
