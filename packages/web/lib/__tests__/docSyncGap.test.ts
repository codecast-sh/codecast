import { describe, expect, test } from "bun:test";
import { isSyncGap, shouldResyncOnExternalEdit } from "../docSyncCache";

// A CLI edit rebuilds the snapshot at a bumped version and deletes every
// delta. A client behind that point can fetch no steps, so it can never catch
// up by replay — the only signal that it must remount from the snapshot.
describe("isSyncGap", () => {
  test("server ahead and no steps to replay → gap", () => {
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2620 })).toBe(true);
  });

  test("server ahead but steps bridge it → not a gap (normal catch-up)", () => {
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2662 })).toBe(false);
    expect(isSyncGap({ serverVersion: 2662, localVersion: 2620, stepsVersion: 2640 })).toBe(false);
  });

  test("client at or ahead of server → not a gap", () => {
    expect(isSyncGap({ serverVersion: 2620, localVersion: 2620, stepsVersion: 2620 })).toBe(false);
    expect(isSyncGap({ serverVersion: 2600, localVersion: 2620, stepsVersion: 2620 })).toBe(false);
  });

  test("doc still being created (version ≤ 1) or unknown server → never a gap", () => {
    expect(isSyncGap({ serverVersion: 1, localVersion: 0, stepsVersion: 0 })).toBe(false);
    expect(isSyncGap({ serverVersion: null, localVersion: 5, stepsVersion: 5 })).toBe(false);
    expect(isSyncGap({ serverVersion: undefined, localVersion: 5, stepsVersion: 5 })).toBe(false);
  });
});

// Regression for the "Inconsistent open depths" TransformError (2026-08-28):
// ExternalEditSync used to push a CLI edit into a live collab editor with
// `setContent`, corrupting prosemirror-collab's step bookkeeping. The fix
// remounts instead (like isSyncGap), gated by this decision so a doc's first
// load — which already reflects the current cliEditedAt stamp — never
// triggers a redundant remount of an editor that just mounted.
describe("shouldResyncOnExternalEdit", () => {
  test("cliEditedAt changes under a live editor → resync", () => {
    expect(shouldResyncOnExternalEdit(1784105015602, 1784105099999)).toBe(true);
  });

  test("first time this editor instance sees a stamp (mount) → not a resync", () => {
    expect(shouldResyncOnExternalEdit(null, 1784105015602)).toBe(false);
    expect(shouldResyncOnExternalEdit(undefined, 1784105015602)).toBe(false);
  });

  test("stamp unchanged, or doc never CLI-edited → not a resync", () => {
    expect(shouldResyncOnExternalEdit(1784105015602, 1784105015602)).toBe(false);
    expect(shouldResyncOnExternalEdit(null, null)).toBe(false);
    expect(shouldResyncOnExternalEdit(1784105015602, null)).toBe(false);
  });
});
