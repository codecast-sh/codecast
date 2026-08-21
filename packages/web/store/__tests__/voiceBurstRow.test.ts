import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The sender's own bubble, over a burst's life.
//
// A walkie burst is a message, so it obeys the message law: it is on screen
// before anything is awaited, the server's row takes its place without the
// bubble moving, and a burst nobody meant to send leaves nothing behind. The
// twist is that the burst keeps WRITING to the row after the supersede — the
// transcript arrives for seconds after the id changed underneath it.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const CHANNEL = serverId("chanA");
const ME = serverId("userme");
const REAL = serverId("msgreal");
const CLIENT = "voice-1-abc";
const ROOM = `dm:${serverId("a")}:${serverId("b")}`;

const serverRow = (over: Record<string, any> = {}) => ({
  _id: REAL,
  client_id: CLIENT,
  channel_id: CHANNEL,
  user_id: ME,
  author_kind: "user" as const,
  content: "",
  voice: { status: "live" as const, room_key: ROOM },
  created_at: 10,
  updated_at: 10,
  ...over,
});

describe("walkie: the sender's own bubble", () => {
  beforeEach(() => {
    useInboxStore.setState({
      chatChannels: {},
      chatMessages: {},
      chatReactions: {},
      chatReads: {},
      chatRail: [],
      pending: {},
      currentUser: { _id: ME },
    } as any);
  });

  it("paints a live bubble before the server has heard a word", () => {
    useInboxStore.getState().beginVoiceBurstRow(CHANNEL, CLIENT, ROOM);
    const row = useInboxStore.getState().chatMessages[CLIENT];
    expect(row?.voice).toEqual({ status: "live", room_key: ROOM });
    expect(row?.user_id).toBe(ME);
    expect(row?.content).toBe("");
    // Talking is reading: the room the burst went into is not unread to its
    // own speaker.
    const read = Object.values(useInboxStore.getState().chatReads).find(
      (r: any) => r.channel_id === CHANNEL,
    ) as any;
    expect(read?.last_read_at).toBeGreaterThan(0);
  });

  it("keeps writing the transcript after the server row supersedes the stub", () => {
    const s = () => useInboxStore.getState();
    s().beginVoiceBurstRow(CHANNEL, CLIENT, ROOM);
    s().syncTable("chatMessages", [serverRow()]);
    // The altKey supersede rekeyed the bubble onto the real id.
    expect(s().chatMessages[CLIENT]).toBeUndefined();
    expect(s().chatMessages[REAL]).toBeDefined();

    s().updateVoiceBurstRow({ clientId: CLIENT, messageId: REAL }, { content: "on my way" });
    expect(s().chatMessages[REAL].content).toBe("on my way");

    s().updateVoiceBurstRow(
      { clientId: CLIENT, messageId: REAL },
      { content: "on my way", status: "done", durationMs: 2400, attachments: [{ storage_id: "st1", mime: "audio/webm" }] },
    );
    expect(s().chatMessages[REAL].voice).toEqual({
      status: "done",
      duration_ms: 2400,
      room_key: ROOM,
    });
    expect(s().chatMessages[REAL].attachments).toEqual([{ storage_id: "st1", mime: "audio/webm" }]);
  });

  it("writes to the stub while the start mutation is still in flight", () => {
    const s = () => useInboxStore.getState();
    s().beginVoiceBurstRow(CHANNEL, CLIENT, ROOM);
    // No message id yet — the words still have to land somewhere.
    s().updateVoiceBurstRow({ clientId: CLIENT, messageId: null }, { content: "hey" });
    expect(s().chatMessages[CLIENT].content).toBe("hey");
  });

  it("takes a cancelled burst back, and a late push cannot resurrect it", () => {
    const s = () => useInboxStore.getState();
    s().beginVoiceBurstRow(CHANNEL, CLIENT, ROOM);
    s().syncTable("chatMessages", [serverRow()]);
    s().dropVoiceBurstRow({ clientId: CLIENT, messageId: REAL });
    expect(s().chatMessages[REAL]).toBeUndefined();
    expect(s().chatMessages[CLIENT]).toBeUndefined();

    // The live subscription can still be holding the row it read before the
    // cancel deleted it server-side; the exclude tombstone is what keeps the
    // bubble gone.
    s().syncTable("chatMessages", [serverRow()]);
    expect(s().chatMessages[REAL]).toBeUndefined();
  });
});
