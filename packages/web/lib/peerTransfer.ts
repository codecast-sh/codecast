// The daemon repeats its last report every few seconds; a row this old has no
// daemon behind it, and its Cancel would never be read.
export const PEER_TRANSFER_STALE_MS = 30_000;
