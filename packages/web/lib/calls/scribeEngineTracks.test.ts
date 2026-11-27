import { afterAll, expect, mock, test } from "bun:test";

// The pipe is the network edge; record which tracks pipes open on and close.
const opened: { track: unknown; closed: boolean }[] = [];
const real = { ...(await import("./asrPipe")) };
mock.module("./asrPipe", () => ({
  ...real,
  openAsrPipe: (opts: { track: unknown }) => {
    const rec = { track: opts.track, closed: false };
    opened.push(rec);
    return { speaking: false, finish: async () => {}, close: () => void (rec.closed = true) };
  },
}));
const { createScribeEngine } = await import("./scribeEngine");

const convex = {
  mutation: async () => ({ transcript_id: "t1", role: "scribe" }),
  action: async () => ({}),
};

// A device change restarts the scribe's own mic in place: same publication and
// key, a new MediaStreamTrack, the old one stopped. The pipe must move to the
// new track, or the scribe's voice drops out of the transcript for the rest of
// the huddle (Cam's lines in cl-202, cl-203 and cl-209).
test("attaching a key with a new track replaces the pipe on the old one", async () => {
  const engine = createScribeEngine();
  await engine.start({ convex, roomKey: "room" });
  const before = { id: "a", readyState: "live" } as unknown as MediaStreamTrack;
  const after = { id: "b", readyState: "live" } as unknown as MediaStreamTrack;

  engine.attach("local:TR_1", before, "u1", "Cam");
  engine.attach("local:TR_1", before, "u1", "Cam");
  expect(opened).toHaveLength(1);

  engine.attach("local:TR_1", after, "u1", "Cam");
  expect(opened).toHaveLength(2);
  expect(opened[0]).toEqual({ track: before, closed: true });
  expect(opened[1]).toEqual({ track: after, closed: false });
  expect(engine.getStatus().trackCount).toBe(1);
  await engine.stop({ keepLive: true });
});

// The phone has no MediaStreamTrack: it hands the engine an opener for a PCM
// session. Its words go out under the speaker it was attached as, like a track's.
test("attachPcm opens one pipe per opener and attributes its words", async () => {
  const appended: any[] = [];
  const phoneConvex = {
    mutation: async (_fn: unknown, args: any) => {
      if (args.segments) appended.push(...args.segments);
      return { transcript_id: "t2", role: "scribe" };
    },
    action: async () => ({}),
  };
  const engine = createScribeEngine();
  await engine.start({ convex: phoneConvex, roomKey: "dm:u1" });
  let events: any = null;
  let opens = 0;
  const open = (o: any) => {
    opens++;
    events = o.events;
    return { speaking: false, finish: async () => {}, close: () => {} };
  };
  engine.attachPcm("local:mic", open, "u1", "Cam");
  engine.attachPcm("local:mic", open, "u1", "Cam");
  expect(opens).toBe(1);
  expect(engine.getStatus().trackCount).toBe(1);

  events.onUtterance({ text: "hello", t0: 0, t1: 500 });
  await Promise.resolve();
  expect(appended).toEqual([{ speaker_id: "u1", speaker_name: "Cam", text: "hello", t0: 0, t1: 500 }]);
  await engine.stop({ keepLive: true });
});

test("finishPipe keeps a pipe's last words, then detaches it", async () => {
  const appended: string[] = [];
  const c = {
    mutation: async (_fn: unknown, args: any) => {
      if (args.segments) appended.push(...args.segments.map((x: any) => x.text));
      return { transcript_id: "t3", role: "scribe" };
    },
    action: async () => ({}),
  };
  const engine = createScribeEngine();
  await engine.start({ convex: c, roomKey: "dm:u1" });
  engine.attachPcm("local:mic", (o: any) => ({
    speaking: false,
    finish: async () => o.events.onUtterance({ text: "said before mute", t0: 0, t1: 1 }),
    close: () => {},
  }), "u1", "Cam");
  await engine.finishPipe("local:mic");
  await Promise.resolve();
  expect(appended).toEqual(["said before mute"]);
  expect(engine.getStatus().trackCount).toBe(0);
  await engine.stop({ keepLive: true });
});

// A dropped pipe reopens a second later, but not on a mic its caller has
// closed in the meantime (a phone muted in that second).
test("attachPcm's alive gates the reopen after a drop", async () => {
  const c = { mutation: async () => ({ transcript_id: "t4", role: "scribe" }), action: async () => ({}) };
  const engine = createScribeEngine();
  await engine.start({ convex: c, roomKey: "dm:u1" });
  let opens = 0;
  let events: any = null;
  let micOpen = true;
  engine.attachPcm("local:mic", (o: any) => {
    opens++;
    events = o.events;
    return { speaking: false, finish: async () => {}, close: () => {} };
  }, "u1", "Cam", () => micOpen);
  events.onDropped();
  micOpen = false;
  await new Promise((r) => setTimeout(r, 1_100));
  expect(opens).toBe(1);
  expect(engine.getStatus().trackCount).toBe(0);
  await engine.stop({ keepLive: true });
});

// The reviewer's repro, with no `alive` from the caller: a pipe finished on
// purpose during its reopen wait stays finished.
test("a pipe finished during its reopen wait is not reopened", async () => {
  const c = { mutation: async () => ({ transcript_id: "t5", role: "scribe" }), action: async () => ({}) };
  const engine = createScribeEngine();
  await engine.start({ convex: c, roomKey: "dm:u1" });
  let opens = 0;
  let events: any = null;
  engine.attachPcm("local:mic", (o: any) => {
    opens++;
    events = o.events;
    return { speaking: false, finish: async () => {}, close: () => {} };
  }, "u1", "Cam");
  events.onDropped();
  await engine.finishPipe("local:mic");
  await new Promise((r) => setTimeout(r, 1_100));
  expect(opens).toBe(1);
  expect(engine.getStatus().trackCount).toBe(0);
  await engine.stop({ keepLive: true });
});

afterAll(() => mock.restore());
