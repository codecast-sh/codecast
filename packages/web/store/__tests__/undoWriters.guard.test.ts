import { describe, expect, test } from "bun:test";
import { CLIENT_SYNC_REGISTRY } from "../clientSyncRegistry";
import { LOCAL_ONLY_UNDO_KEYS, UNDO_WRITERS } from "../undo/writers";

// An undo reaches the server one of two ways: keys with a dispatchTable ride
// the engine's applyUndoPatches pass; every other local-first key needs a
// writer naming the action that carries a row's prior values, or a stated
// reason it needs none. Without either, an undo would restore the row locally
// and the next sync would put the forward value back.
const offRail = Object.entries(CLIENT_SYNC_REGISTRY as Record<string, { localFirst?: boolean; dispatchTable?: unknown }>)
  .filter(([, entry]) => entry.localFirst && !entry.dispatchTable)
  .map(([key]) => key)
  .sort();

describe("undo reaches the server for every local-first key", () => {
  test("every key off the patch rail has a writer or a local-only reason", () => {
    const missing = offRail.filter((key) => !(key in UNDO_WRITERS) && !(key in LOCAL_ONLY_UNDO_KEYS));
    expect(missing).toEqual([]);
  });

  test("no key is both written and declared local-only", () => {
    const both = Object.keys(UNDO_WRITERS).filter((key) => key in LOCAL_ONLY_UNDO_KEYS);
    expect(both).toEqual([]);
  });

  test("every listed key is a real local-first key off the rail, and every reason is written", () => {
    const known = new Set(offRail);
    const stale = [...Object.keys(UNDO_WRITERS), ...Object.keys(LOCAL_ONLY_UNDO_KEYS)].filter((key) => !known.has(key));
    expect(stale).toEqual([]);
    const bare = Object.entries(LOCAL_ONLY_UNDO_KEYS).filter(([, reason]) => !reason.trim()).map(([key]) => key);
    expect(bare).toEqual([]);
  });
});
