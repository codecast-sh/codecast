import { describe, expect, it } from "bun:test";
import { messagesSig } from "../useChatSync";
import type { ChatMessageRow } from "../../store/inboxStore";

// The chat transcript re-renders only when this signature moves, so anything the
// bubble branches on has to be in it. A walkie burst is the case that caught it:
// finalizing one changes `voice` and `attachments` and, in normal use, nothing
// else — the words have already streamed into `content` while the key was down.
// Leaving those two out hashed a finished burst identically to a live one, and
// the sender's own bubble stayed on "talking…" until a reload.

const msg = (over: Partial<ChatMessageRow> = {}): ChatMessageRow => ({
  _id: "m1",
  channel_id: "c1",
  user_id: "u1",
  content: "back in five",
  created_at: 1_000,
  updated_at: 1_000,
  ...over,
});

// makeCollectionSig memoizes on the collection ref, so every call gets its own.
const sig = (...rows: ChatMessageRow[]) =>
  messagesSig(Object.fromEntries(rows.map((r) => [r._id, r])));

describe("messagesSig — a burst finalizing wakes the transcript", () => {
  const live = msg({ voice: { status: "live", room_key: "dm:a:b" } });

  it("flips when voice.status goes live -> done and nothing else moves", () => {
    const done = msg({ voice: { status: "done", room_key: "dm:a:b" } });
    expect(sig(done)).not.toBe(sig(live));
  });

  it("flips on the whole finalize — status, duration and the recording", () => {
    const done = msg({
      voice: { status: "done", duration_ms: 24_940, room_key: "dm:a:b" },
      attachments: [{ storage_id: "st1", mime: "audio/webm", name: "voice.webm" }],
    });
    expect(sig(done)).not.toBe(sig(live));
  });

  it("flips when a cancelled burst becomes a tombstone", () => {
    expect(sig(msg({ voice: { status: "canceled" }, deleted_at: 2_000 }))).not.toBe(sig(live));
  });

  it("flips when an attachment lands on an ordinary message", () => {
    const bare = msg({ content: "here it is" });
    const withFile = msg({
      content: "here it is",
      attachments: [{ storage_id: "st1", mime: "image/png" }],
    });
    expect(sig(withFile)).not.toBe(sig(bare));
  });

  it("stays put when a push carries the same fields again", () => {
    // Cheapness is the other half of the contract: a re-push that changed
    // nothing the bubble reads must not re-render the transcript.
    expect(sig(msg({ updated_at: 9_999 }))).toBe(sig(msg()));
    const same = { status: "done" as const, duration_ms: 1_500, room_key: "dm:a:b" };
    expect(sig(msg({ voice: { ...same } }))).toBe(sig(msg({ voice: { ...same } })));
  });
});
