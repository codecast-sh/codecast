// A frame of a call an agent Reads syncs as the moment's reference, never as
// the picture: the picture would reach everyone who can read the session,
// outside the call's own access rule, and outlive the recording.
// Run: bun test src/callFrameRefs.test.ts
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callFrameSeenRef } from "@codecast/shared/contracts";
import { replayFrameSeenRef } from "@codecast/shared/contracts/replayPlayer";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-frames-"));
const savedDir = process.env.CODECAST_DIR;
process.env.CODECAST_DIR = path.join(home, ".codecast");

const { referenceCallFrames, rememberCallFrames, resetCallFrameMemory, callFrameAtPath } = await import("./callFrameRefs.js");
const { parseSessionFile } = await import("./parser.js");
const { SyncService } = await import("./syncService.js");

afterAll(() => {
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 7)]);

function writeFrame(name: string, body: Buffer = PNG): string {
  const dir = path.join(home, ".codecast", "tmp", "calls");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** The two lines Claude Code writes for a Read of an image: the call on the
 *  assistant's line, the picture (recompressed, no path) on the next. */
function readLines(id: string, file: string, bytes: number) {
  const call = {
    type: "assistant",
    uuid: `a-${id}`,
    timestamp: "2026-10-04T10:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] },
  };
  const result = {
    type: "user",
    uuid: `u-${id}`,
    timestamp: "2026-10-04T10:00:01.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" } }] }] },
    toolUseResult: { type: "image", file: { base64: "/9j/AAAA", type: "image/jpeg", originalSize: bytes, dimensions: { originalWidth: 1920, originalHeight: 1080 } } },
  };
  return { call: JSON.stringify(call), result: JSON.stringify(result) };
}

beforeEach(() => resetCallFrameMemory());

describe("a Read of a snapped frame", () => {
  it("parses to the moment's reference on the tool result, and no image", () => {
    const file = writeFrame("cl-117_2m30s_screen.png");
    rememberCallFrames([{ path: file, ref: "cl-117@2:30", recording_id: "r1", width: 1920, height: 1080 }]);
    const { call, result } = readLines("toolu_1", file, PNG.length);
    const messages = parseSessionFile(`${call}\n${result}\n`);
    // The parser still sees the picture; the reference replaces it before sync.
    expect(messages.some((m) => m.images?.length)).toBe(true);
    expect(referenceCallFrames(messages as any)).toBe(1);
    expect(messages.some((m) => m.images?.length)).toBe(false);
    const res = messages.flatMap((m) => m.toolResults ?? []).find((r) => r.toolUseId === "toolu_1");
    expect(callFrameSeenRef(res?.content)).toBe("cl-117@2:30");
  });

  it("a replay frame becomes the replay's moment, never the customer's page", () => {
    const file = writeFrame("rp-12-83s.png");
    rememberCallFrames([{ path: file, ref: "rp-12@1:23", recording_id: "replay_row", width: 1280, height: 800 }]);
    const { call, result } = readLines("toolu_rp", file, PNG.length);
    const messages = parseSessionFile(`${call}\n${result}\n`);
    expect(referenceCallFrames(messages as any)).toBe(1);
    expect(messages.some((m) => m.images?.length)).toBe(false);
    const res = messages.flatMap((m) => m.toolResults ?? []).find((r) => r.toolUseId === "toolu_rp");
    expect(replayFrameSeenRef(res?.content)).toBe("rp-12@1:23");
    expect(callFrameSeenRef(res?.content)).toBeNull();
    // Said once, however often it is replaced.
    expect(referenceCallFrames(messages as any)).toBe(0);
  });

  it("is known in a later batch than its Read, and after a restart forgot the Read", () => {
    const file = writeFrame("cl-117_2m45s_screen.png");
    rememberCallFrames([{ path: file, ref: "cl-117@2:45", recording_id: "r1", width: 1920, height: 1080 }]);
    const { call, result } = readLines("toolu_2", file, PNG.length);
    // The call syncs first, the picture in the next batch.
    referenceCallFrames(parseSessionFile(`${call}\n`) as any);
    const later = parseSessionFile(`${result}\n`);
    expect(referenceCallFrames(later as any)).toBe(1);
    expect(later[0].images).toBeUndefined();
    // A daemon that restarted between them knows the frame by its file's size
    // and dimensions, which Claude Code records beside the picture.
    resetCallFrameMemory();
    const again = parseSessionFile(`${result}\n`);
    expect(referenceCallFrames(again as any)).toBe(1);
    expect(callFrameSeenRef(again[0].toolResults?.[0].content)).toBe("cl-117@2:45");
  });

  it("leaves every other image alone: a screenshot, a picture of another size", () => {
    const frame = writeFrame("cl-1_0m10s.png");
    rememberCallFrames([{ path: frame, ref: "cl-1@0:10", recording_id: "r9", width: 1920, height: 1080 }]);
    const shot = path.join(home, "shot.png");
    fs.writeFileSync(shot, PNG);
    const { call, result } = readLines("toolu_3", shot, PNG.length + 1);
    const messages = parseSessionFile(`${call}\n${result}\n`);
    expect(referenceCallFrames(messages as any)).toBe(0);
    expect(messages.some((m) => m.images?.length)).toBe(true);
  });

  it("remembers each tile of a frame under the frame's reference", () => {
    const whole = writeFrame("cl-5_1m00s.png");
    const tile = writeFrame("cl-5_1m00s_tl.png", Buffer.concat([PNG, Buffer.alloc(10)]));
    rememberCallFrames([{ path: whole, ref: "cl-5@1:00", recording_id: "r5", width: 3840, height: 2160, tiles: [{ path: tile, width: 1920, height: 1080 }] }]);
    expect(callFrameAtPath(tile)?.ref).toBe("cl-5@1:00");
    const msg = { content: "", images: [{ localPath: tile, toolUseId: "t" }], toolResults: [{ toolUseId: "t", content: "" }] };
    expect(referenceCallFrames([msg])).toBe(1);
    expect(msg.toolResults[0].content).toBe("Frame of the call: cl-5@1:00");
  });

  it("never rewrites a person's own turn: an image they attached stays as it is", () => {
    const frame = writeFrame("cl-9_0m20s.png");
    rememberCallFrames([{ path: frame, ref: "cl-9@0:20", recording_id: "r9", width: 1920, height: 1080 }]);
    const typed = { role: "human", content: "look at this", images: [{ localPath: frame }] };
    expect(referenceCallFrames([typed])).toBe(0);
    expect(typed.content).toBe("look at this");
    expect(typed.images).toHaveLength(1);
  });
});

describe("the sync", () => {
  it("uploads nothing for a frame, and carries the reference instead", async () => {
    const file = writeFrame("cl-117_3m00s_screen.png");
    rememberCallFrames([{ path: file, ref: "cl-117@3:00", recording_id: "r1", width: 1920, height: 1080 }]);
    const { call, result } = readLines("toolu_4", file, PNG.length);
    const messages = parseSessionFile(`${call}\n${result}\n`);
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    let uploads = 0;
    (sync as any).uploadImage = async () => {
      uploads++;
      return "sid";
    };
    await sync.offloadImages(messages as any);
    expect(uploads).toBe(0);
    expect(messages.some((m) => m.images?.length)).toBe(false);
    expect(messages.flatMap((m) => m.toolResults ?? []).map((r) => callFrameSeenRef(r.content))).toContain("cl-117@3:00");
  });

  it("rewrites a markdown link to a frame as the reference, never uploading it", async () => {
    const file = writeFrame("cl-117_3m10s_screen.png");
    rememberCallFrames([{ path: file, ref: "cl-117@3:10", recording_id: "r1", width: 1920, height: 1080 }]);
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    let uploads = 0;
    (sync as any).uploadImage = async () => {
      uploads++;
      return "sid";
    };
    const msg = { role: "assistant", content: `The slide changed:\n\n![frame](${file})\n\nas planned.` };
    await sync.rescueLocalImageLinks([msg]);
    expect(uploads).toBe(0);
    expect(msg.content).toBe("The slide changed:\n\ncl-117@3:10\n\nas planned.");
  });
});
