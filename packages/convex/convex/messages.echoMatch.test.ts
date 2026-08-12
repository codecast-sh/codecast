import { describe, expect, test } from "bun:test";
import { DELIVERED_ECHO_ADOPTION_WINDOW_MS, findEchoedPendingMessage, injectedImageRefs, resolveEchoImages } from "./messages";

// The command-id coverage proof rides on echo→pending matching: the matched
// row's client_id is stamped onto the transcript row, and v2 overlays reconcile
// against that id. Matching newest-first over every status let the echo of an
// OLDER identical-content delivery stamp the NEWER command's id (ABA): the
// newer overlay retired without delivery and the delivered command's overlay
// could never reconcile. Matching is therefore delivery-ordered (oldest first)
// and restricted to rows still awaiting proof.

const row = (
  id: string,
  content: string,
  createdAt: number,
  status: string,
  clientId = id,
  extra: { delivered_at?: number; echo_message_id?: string } = {},
) => ({ _id: id, content, created_at: createdAt, status, client_id: clientId, ...extra });

describe("findEchoedPendingMessage", () => {
  test("ABA regression: the echo matches the OLDER in-flight row, not the newest", () => {
    const a = row("cmd-a", "continue", 1_000, "injected");
    const b = row("cmd-b", "continue", 2_000, "pending");
    expect(findEchoedPendingMessage([b, a], "continue", 3_000)?._id).toBe("cmd-a");
  });

  test("terminal rows never re-match: a delivered twin cannot absorb the echo", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered");
    const b = row("cmd-b", "continue", 2_000, "pending");
    expect(findEchoedPendingMessage([a, b], "continue", 3_000)?._id).toBe("cmd-b");
  });

  test("cancelled and undeliverable rows never match", () => {
    const a = row("cmd-a", "stop", 1_000, "cancelled");
    const b = row("cmd-b", "stop", 2_000, "undeliverable");
    expect(findEchoedPendingMessage([a, b], "stop", 3_000)).toBeUndefined();
  });

  test("a consumed row is skipped so a batch's second echo reaches the second command", () => {
    const a = row("cmd-a", "continue", 1_000, "injected");
    const b = row("cmd-b", "continue", 2_000, "injected");
    const consumed = new Set(["cmd-a"]);
    expect(findEchoedPendingMessage([a, b], "continue", 3_000, consumed)?._id).toBe("cmd-b");
  });

  test("an in-flight row outranks an older watchdog-failed twin", () => {
    const a = row("cmd-a", "continue", 1_000, "failed");
    const b = row("cmd-b", "continue", 2_000, "injected");
    expect(findEchoedPendingMessage([a, b], "continue", 3_000)?._id).toBe("cmd-b");
  });

  test("a late echo still recovers a watchdog-failed row that actually landed", () => {
    const a = row("cmd-a", "continue", 1_000, "failed");
    expect(findEchoedPendingMessage([a], "continue", 500_000)?._id).toBe("cmd-a");
  });

  test("whitespace-flattened content still matches, preserving the original fuzz", () => {
    const a = row("cmd-a", "line one\nline two", 1_000, "pending");
    expect(findEchoedPendingMessage([a], "line one line two", 2_000)?._id).toBe("cmd-a");
  });

  // The status ack (updateAgentStatus's "agent went active" promotion) can
  // terminalize an injected row seconds before its echo syncs. The echo must
  // still adopt such a row — losing the match dropped from_user_id on team
  // sends and client_id/images on web sends (doubled-image incident).
  test("status-ack race: a recently delivered, never-echoed row is adopted", () => {
    const a = row("cmd-a", "remove me from this thread", 1_000, "delivered", "cmd-a", {
      delivered_at: 2_000,
    });
    expect(findEchoedPendingMessage([a], "remove me from this thread", 1_800)?._id).toBe("cmd-a");
  });

  test("a delivered row already tied to its echo can never be re-adopted", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered", "cmd-a", {
      delivered_at: 2_000,
      echo_message_id: "msg-1",
    });
    expect(findEchoedPendingMessage([a], "continue", 2_500)).toBeUndefined();
  });

  test("a delivered row outside the adoption window never matches", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered", "cmd-a", {
      delivered_at: 2_000,
    });
    const late = 2_000 + DELIVERED_ECHO_ADOPTION_WINDOW_MS + 1;
    expect(findEchoedPendingMessage([a], "continue", late)).toBeUndefined();
  });

  test("a delivered row without delivered_at never matches (legacy shape)", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered");
    expect(findEchoedPendingMessage([a], "continue", 2_000)).toBeUndefined();
  });

  test("an in-flight row outranks a recently delivered twin", () => {
    const a = row("cmd-a", "continue", 1_000, "delivered", "cmd-a", { delivered_at: 1_500 });
    const b = row("cmd-b", "continue", 2_000, "injected");
    expect(findEchoedPendingMessage([a, b], "continue", 2_500)?._id).toBe("cmd-b");
  });

  // The composer stamps a numbered "[Image N]" token into the draft text for
  // every attached image, so the PENDING row's content carries the token too.
  // Matching stripped image tokens from the echo side only, so a text+image
  // send never matched its echo: the stored transcript row kept the raw echo
  // content and never adopted images/client_id/from_user_id — the web bubble
  // rendered the text with no thumbnail.
  test("composer [Image N] token in the pending content still matches its echo", () => {
    const pending = {
      ...row("cmd-a", "[Image 1] this message was not a skill", 1_000, "injected"),
      image_storage_ids: ["kg2b6ks3phj21khqs7bj94x6kn8c9c6s"],
    };
    const echo =
      "[Image 1] this message was not a skill [Image /tmp/codecast/images/kg2b6ks3phj21khqs7bj94x6kn8c9c6s.png]";
    expect(findEchoedPendingMessage([pending], echo, 2_000)?._id).toBe("cmd-a");
  });

  test("image-only send with a [Image N] token matches via the echoed storage id", () => {
    const pending = {
      ...row("cmd-a", "[Image 1]", 1_000, "injected"),
      image_storage_ids: ["kg2b6ks3phj21khqs7bj94x6kn8c9c6s"],
    };
    const echo = "[Image /tmp/codecast/images/kg2b6ks3phj21khqs7bj94x6kn8c9c6s.png]";
    expect(findEchoedPendingMessage([pending], echo, 2_000)?._id).toBe("cmd-a");
  });

  test("legacy [image] placeholder in the pending content still matches", () => {
    const pending = {
      ...row("cmd-a", "[image]", 1_000, "injected"),
      image_storage_ids: ["kg2b6ks3phj21khqs7bj94x6kn8c9c6s"],
    };
    const echo = "[Image /tmp/codecast/images/kg2b6ks3phj21khqs7bj94x6kn8c9c6s.png]";
    expect(findEchoedPendingMessage([pending], echo, 2_000)?._id).toBe("cmd-a");
  });

  // Terminal injection is lossy: the daemon clears the client's composer with
  // Ctrl+A / Ctrl+K, and when the input isn't ready those keys land as literal
  // \x01 / \x0b inside the echoed turn — sometimes on top of a stray character
  // already sitting in the prompt. Both happened in prod on 2026-08-12 and both
  // broke exact-text matching, so the bubble lost its thumbnail. The echoed
  // storage id is the join key that survives any of it.
  const SID = "kg25ynm6vjbf4610s3rx1wpmdh8cahwy";

  test("echoed storage id matches through leaked control bytes and a stray prefix", () => {
    const pending = {
      ...row("cmd-a", "[Image 1] sometimes diff panel header gets into this state", 1_000, "injected"),
      image_storage_ids: [SID],
    };
    const echo =
      `q[Image 1] sometimes diff panel header gets into this state [Image /tmp/codecast/images/${SID}.png]`;
    expect(findEchoedPendingMessage([pending], echo, 2_000)?._id).toBe("cmd-a");
  });

  test("leaked control bytes alone don't break a text-only match", () => {
    const a = row("cmd-a", "ship it", 1_000, "injected");
    expect(findEchoedPendingMessage([a], "ship it", 2_000)?._id).toBe("cmd-a");
  });

  test("the storage-id tier still respects delivery order across a reused draft id", () => {
    const a = { ...row("cmd-a", "[Image 1] look", 1_000, "delivered", "cmd-a", { echo_message_id: "msg-1" }), image_storage_ids: [SID] };
    const b = { ...row("cmd-b", "[Image 1] look", 2_000, "injected"), image_storage_ids: [SID] };
    const echo = `[Image 1] look [Image /tmp/codecast/images/${SID}.png]`;
    expect(findEchoedPendingMessage([a, b], echo, 3_000)?._id).toBe("cmd-b");
  });

  test("a cancelled row never absorbs an echo by storage id", () => {
    const a = { ...row("cmd-a", "[Image 1] look", 1_000, "cancelled"), image_storage_ids: [SID] };
    const echo = `[Image 1] look [Image /tmp/codecast/images/${SID}.png]`;
    expect(findEchoedPendingMessage([a], echo, 2_000)).toBeUndefined();
  });

  test("an echoed id belonging to no pending row matches nothing", () => {
    const a = { ...row("cmd-a", "[Image 1] look", 1_000, "injected"), image_storage_ids: ["other"] };
    const echo = `totally different text [Image /tmp/codecast/images/${SID}.png]`;
    expect(findEchoedPendingMessage([a], echo, 2_000)).toBeUndefined();
  });
});

describe("resolveEchoImages", () => {
  const SID = "kg2d8yf566mpk8b702ce2w4nwx8cb5zt";

  test("images already carried by the sync win", () => {
    const existing = [{ media_type: "image/png", storage_id: "from-sync" }];
    expect(resolveEchoImages(existing, { image_storage_ids: [SID] }, "")).toBe(existing);
  });

  test("the paired pending row's ids take the media type from the echoed filename", () => {
    expect(
      resolveEchoImages(undefined, { image_storage_ids: [SID] }, `[Image /tmp/codecast/images/${SID}.webp]`),
    ).toEqual([{ media_type: "image/webp", storage_id: SID }]);
  });

  // With no pending row the only ids left are the ones in the message text,
  // which anyone can type. null says "verify these against storage first" —
  // inserting an id that names no object fails schema validation and loses the
  // whole message, so the caller must not trust them blind.
  test("with no pending row the echoed ids are handed back for verification", () => {
    expect(
      resolveEchoImages(undefined, undefined, `text [Image /tmp/codecast/images/${SID}.jpeg]`),
    ).toBeNull();
    expect(
      resolveEchoImages(undefined, { image_storage_ids: [] }, `[Image /tmp/codecast/images/${SID}.jpeg]`),
    ).toBeNull();
  });

  test("plain text asks for nothing", () => {
    expect(resolveEchoImages(undefined, undefined, "no images here")).toBeUndefined();
  });
});

describe("injectedImageRefs", () => {
  const SID = "kg2d8yf566mpk8b702ce2w4nwx8cb5zt";

  test("media type comes from the extension the daemon wrote", () => {
    for (const [ext, type] of [["png", "image/png"], ["webp", "image/webp"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"]]) {
      expect(injectedImageRefs(`[Image /tmp/codecast/images/${SID}.${ext}]`)).toEqual([
        { media_type: type, storage_id: SID },
      ]);
    }
  });

  test("a path repeated in one turn yields one image", () => {
    const echo = `[Image /tmp/codecast/images/${SID}.gif] and again /tmp/codecast/images/${SID}.gif`;
    expect(injectedImageRefs(echo)).toEqual([{ media_type: "image/gif", storage_id: SID }]);
  });

  test("prose that merely mentions an image path yields nothing", () => {
    expect(injectedImageRefs("no images here")).toEqual([]);
    expect(injectedImageRefs("/tmp/codecast/images/report.txt")).toEqual([]);
  });
});
