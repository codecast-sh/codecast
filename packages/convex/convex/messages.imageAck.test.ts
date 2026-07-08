import { describe, expect, test } from "bun:test";
import { injectedImageStorageIds, imageEchoMatchesPending } from "./messages";

// The daemon delivers an image as `[Image /tmp/codecast/images/<storageId>.png]`
// (downloadImage names the file by its storage id), so the agent's echoed user
// turn carries the pending row's storage id verbatim. The image-only ack used to
// rely on a ±120s window between the echo and the pending row's created_at — which
// fails for any image sent to a session busy >2min, looping the delivery forever
// (ct-36607). Match on the storage id instead.

const STORAGE_ID = "kg2ebjm7ap58rd1qxva17966dx88abzm";
const ECHO = `[Image /tmp/codecast/images/${STORAGE_ID}.png]`;

describe("injectedImageStorageIds", () => {
  test("extracts the storage id from an injected-image echo path", () => {
    expect(injectedImageStorageIds(ECHO)).toEqual([STORAGE_ID]);
  });

  test("extracts every id when multiple images are injected together", () => {
    const two = `[Image /tmp/codecast/images/aaa111.png] [Image /tmp/codecast/images/bbb222.png]`;
    expect(injectedImageStorageIds(two)).toEqual(["aaa111", "bbb222"]);
  });

  test("returns nothing for a path-less / text echo", () => {
    expect(injectedImageStorageIds("just some text")).toEqual([]);
    expect(injectedImageStorageIds("")).toEqual([]);
  });
});

describe("imageEchoMatchesPending", () => {
  // The regression: echo arrives 5 minutes after the user sent the image (session
  // was busy). The old ±120s window would reject this and re-deliver forever.
  const lateEcho = { created_at: 0, image_storage_ids: [STORAGE_ID] };
  const msgTs = 300_000; // 5 min later

  test("matches a stale echo by storage id, regardless of the 120s window", () => {
    expect(imageEchoMatchesPending(lateEcho, ECHO, msgTs)).toBe(true);
  });

  test("matches when the pending row uses the singular image_storage_id", () => {
    const pm = { created_at: 0, image_storage_id: STORAGE_ID };
    expect(imageEchoMatchesPending(pm, ECHO, msgTs)).toBe(true);
  });

  test("does NOT match a different image's echo (no false-positive ack)", () => {
    const other = { created_at: 0, image_storage_ids: ["someotherid"] };
    expect(imageEchoMatchesPending(other, ECHO, msgTs)).toBe(false);
  });

  test("does NOT fall back to the time window once the echo carries a parseable id", () => {
    // Same instant, but a non-matching id → still a definitive no-match.
    const other = { created_at: msgTs, image_storage_ids: ["someotherid"] };
    expect(imageEchoMatchesPending(other, ECHO, msgTs)).toBe(false);
  });

  test("falls back to the ±120s window for a path-less echo", () => {
    const pm = { created_at: 0, image_storage_ids: [STORAGE_ID] };
    expect(imageEchoMatchesPending(pm, "", 60_000)).toBe(true); // within window
    expect(imageEchoMatchesPending(pm, "", 300_000)).toBe(false); // outside window
  });
});
