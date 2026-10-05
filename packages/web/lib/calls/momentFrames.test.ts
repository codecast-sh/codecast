// Frames of a call drawn once are kept as pictures in memory: read back by
// file and second, newest kept when the cap is passed (the oldest revoked),
// and gone with the file or the call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { keepCallFrames, keepMomentFrame, MOMENT_FRAME_LIMIT, momentFrame, momentFrameCount, momentFrameKey } from "./momentFrames";

const revoked: string[] = [];
const realRevoke = URL.revokeObjectURL;
const realDocument = (globalThis as any).document;
let tainted = false;

beforeAll(() => {
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  (globalThis as any).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {
          if (tainted) throw Object.assign(new Error("tainted"), { name: "SecurityError" });
        },
      }),
      toBlob: (cb: (b: Blob) => void) => cb(new Blob(["jpeg"], { type: "image/jpeg" })),
    }),
  };
});
afterAll(() => {
  URL.revokeObjectURL = realRevoke;
  (globalThis as any).document = realDocument;
});

const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;

test("a drawn frame is kept by file and second, and read back", async () => {
  const key = momentFrameKey("rec1", 12.3456);
  expect(key).toBe("rec1@12.35");
  expect(momentFrame(key)).toBeNull();
  await keepMomentFrame(key, { call: "call1", recording: "rec1" }, video);
  expect(momentFrame(key)).toMatch(/^blob:/);
});

test("a video with no picture yet, or a canvas the browser will not read, keeps nothing", async () => {
  await keepMomentFrame("rec1@1.00", { call: "call1", recording: "rec1" }, { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement);
  tainted = true;
  await keepMomentFrame("rec1@2.00", { call: "call1", recording: "rec1" }, video);
  tainted = false;
  expect(momentFrame("rec1@1.00")).toBeNull();
  expect(momentFrame("rec1@2.00")).toBeNull();
});

test("past the cap the least recently read goes, and its URL is revoked", async () => {
  keepCallFrames("call1");
  const first = momentFrameKey("rec1", 0);
  await keepMomentFrame(first, { call: "call1", recording: "rec1" }, video);
  for (let i = 1; i < MOMENT_FRAME_LIMIT; i++) await keepMomentFrame(momentFrameKey("rec1", i), { call: "call1", recording: "rec1" }, video);
  const secondUrl = momentFrame(momentFrameKey("rec1", 1))!;
  // Read the first last of all: the second is now the oldest.
  for (let i = 2; i < MOMENT_FRAME_LIMIT; i++) momentFrame(momentFrameKey("rec1", i));
  const firstUrl = momentFrame(first)!;
  await keepMomentFrame("rec1@999.00", { call: "call1", recording: "rec1" }, video);
  expect(momentFrameCount()).toBe(MOMENT_FRAME_LIMIT);
  expect(momentFrame(first)).toBe(firstUrl);
  expect(momentFrame(momentFrameKey("rec1", 1))).toBeNull();
  expect(revoked).toContain(secondUrl);
});

test("a file leaving the call, or the call leaving the viewer, takes its frames", async () => {
  keepCallFrames("call1");
  await keepMomentFrame("a@1.00", { call: "call1", recording: "a" }, video);
  await keepMomentFrame("b@1.00", { call: "call1", recording: "b" }, video);
  await keepMomentFrame("c@1.00", { call: "call2", recording: "c" }, video);
  keepCallFrames("call1", new Set(["a"]));
  expect([momentFrame("a@1.00") !== null, momentFrame("b@1.00") !== null, momentFrame("c@1.00") !== null]).toEqual([true, false, true]);
  keepCallFrames("call2");
  expect(momentFrame("c@1.00")).toBeNull();
});
