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

afterAll(() => mock.restore());
