import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveLineSpeaker } from "@codecast/shared/contracts";
import { useInboxStore } from "../inboxStore";

// A voice note's speaker corrections in the store (callDetails, localFirst):
// an assignment renames every line of that voice in the same frame, holds
// through a push computed before the write committed, and retires on the
// echo; a refusal puts the server's speakers back. Moving a line writes the
// segments whole, and a new voice gets its unknown entry. The voice switch
// lives on currentUser, and turning it off zeroes the sample counts.
const CALL = "k17voicenote";
const seg = (seq: number, speaker_id: string) => ({
  seq, speaker_id, speaker_name: speaker_id === "spk:0" ? "Speaker 1" : "Speaker 2", text: `line ${seq}`, t0: seq, t1: seq + 1, at: 5,
});
const server = (speakers: any[], segments = [seg(1, "spk:0"), seg(2, "spk:1"), seg(3, "spk:0")]) => ({
  _id: CALL, room_key: "rec:x", status: "ended", routes: [], speakers, segments,
});
const SUGGESTED = [{ key: "spk:0", source: "voice" }, { key: "spk:1", user_id: "u2", source: "voice", score: 0.8 }];

describe("call speakers local-first", () => {
  const owner = {};
  let calls: Array<{ action: string; args: any[] }>;
  let reject: boolean;

  beforeEach(() => {
    calls = [];
    reject = false;
    useInboxStore.setState({ callDetails: {}, pending: {}, myVoiceprint: { count: 3, seconds: 12, last_added_at: 9 } } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      if (reject) throw new Error("[CONVEX M(transcripts:assignSpeaker)] Uncaught Error: That person is not on this call's team");
      return null;
    }, { owner });
    useInboxStore.getState().syncTable("callDetails", [server(SUGGESTED)], { isDelta: true });
  });

  afterEach(() => {
    useInboxStore.getState()._clearDispatch(owner);
  });

  const st = () => useInboxStore.getState() as any;
  const call = () => st().callDetails[CALL];
  const names = () => call().segments.map((s: any) => resolveLineSpeaker(s, call().speakers, { u1: "Ann", u2: "Bob" }).name);
  const tick = async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it("an assignment renames every line at once, survives a stale push, and retires on the echo", async () => {
    const p = st().assignCallSpeaker(CALL, "spk:0", { user_id: "u1" });
    expect(names()).toEqual(["Ann", "Bob", "Ann"]);
    await p;
    expect(calls.map((c) => [c.action, c.args])).toEqual([["assignCallSpeaker", [CALL, "spk:0", { user_id: "u1" }]]]);
    // A push computed before the write committed.
    st().syncTable("callDetails", [server(SUGGESTED)], { isDelta: true });
    expect(names()).toEqual(["Ann", "Bob", "Ann"]);
    // The echo, as the server sends it (wire shape): the lock retires.
    const echoed = [{ key: "spk:0", user_id: "u1", source: "person" }, SUGGESTED[1]];
    st().syncTable("callDetails", [server(echoed)], { isDelta: true });
    expect(Object.keys(st().pending).filter((k) => k.startsWith("callDetails:"))).toEqual([]);
  });

  it("a refusal puts the server's speakers back", async () => {
    reject = true;
    await st().assignCallSpeaker(CALL, "spk:0", { name: "  Visitor " }).catch(() => {});
    await tick();
    st().syncTable("callDetails", [server(SUGGESTED)], { isDelta: true });
    expect(names()).toEqual(["Speaker 1", "Bob", "Speaker 1"]);
  });

  it("confirming a suggestion makes it a person's; moving a line to a new voice adds its entry", async () => {
    await st().confirmCallSpeaker(CALL, "spk:1");
    expect(call().speakers[1]).toEqual({ key: "spk:1", user_id: "u2", source: "person" });
    await st().moveCallLineSpeaker(CALL, 3, "spk:2");
    expect(call().segments[2]).toMatchObject({ seq: 3, speaker_id: "spk:2", speaker_name: "Speaker 3" });
    expect(call().speakers[2]).toEqual({ key: "spk:2", source: "person" });
    expect(names()).toEqual(["Speaker 1", "Bob", "Speaker 3"]);
  });

  it("a correction made on another device arrives, though no scalar changed", () => {
    st().syncTable("callDetails", [server([{ key: "spk:0", name: "Visitor", source: "person" }, SUGGESTED[1]])], { isDelta: true });
    expect(names()).toEqual(["Visitor", "Bob", "Visitor"]);
  });

  it("a legacy recording's line is not moved: it has no separated voices", async () => {
    st().syncTable("callDetails", [server([], [seg(1, "mic")])], { isDelta: true });
    await st().moveCallLineSpeaker(CALL, 1, "spk:0").catch(() => {});
    expect(call().segments[0].speaker_id).toBe("mic");
    expect(call().speakers).toEqual([]);
  });

  it("the voice switch writes currentUser and off zeroes the counts", async () => {
    useInboxStore.setState({ currentUser: { _id: "u1", name: "Ann", voice_id_enabled: true } } as any);
    await st().setVoiceIdEnabled(false);
    expect(st().currentUser.voice_id_enabled).toBe(false);
    expect(st().myVoiceprint).toEqual({ count: 0, seconds: 0, last_added_at: null });
    expect(calls.at(-1)).toEqual({ action: "setVoiceIdEnabled", args: [false] });
  });
});
