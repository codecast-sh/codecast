import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clockForName,
  describeSpans,
  frameArgs,
  frameFileName,
  ffmpegFailure,
  lineAt,
  lineFrameMs,
  nearestRecordedMs,
  outputPaths,
  parseSceneScores,
  parseSnapTarget,
  pickSceneMoments,
  recordedSpans,
  sceneArgs,
  snapCall,
  SnapError,
  type FfmpegRunner,
  type SnapRecordings,
} from "./callSnap.js";

const T = Date.UTC(2026, 9, 2, 15, 0, 0);
const s = (n: number) => n * 1000;
const min = (n: number) => n * 60_000;

describe("parseSnapTarget", () => {
  test("a line, a range, a time, now", () => {
    expect(parseSnapTarget("cl-42:15")).toEqual({ call: "cl-42", moment: { kind: "line", from: 15, to: 15 } });
    expect(parseSnapTarget("cl-42:25-15")).toEqual({ call: "cl-42", moment: { kind: "line", from: 15, to: 25 } });
    expect(parseSnapTarget("CL-42@12:34")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget("cl-42@1:02:03")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(3723) } });
    expect(parseSnapTarget("cl-42@754s")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget("cl-42")).toEqual({ call: "cl-42", moment: { kind: "now" } });
    expect(parseSnapTarget("cl-42@now")).toEqual({ call: "cl-42", moment: { kind: "now" } });
  });

  test("a full id or a prefix carries the moment the same way", () => {
    const id = "k57abcdefghijklmnopqrstuvwxyz012";
    expect(parseSnapTarget(`${id}@0:07`)).toEqual({ call: id, moment: { kind: "time", atMs: s(7) } });
    expect(parseSnapTarget("k57abc:3")).toEqual({ call: "k57abc", moment: { kind: "line", from: 3, to: 3 } });
  });

  test("a pasted call page link names its moment", () => {
    const id = "k57abcdefghijklmnopqrstuvwxyz012";
    expect(parseSnapTarget(`https://codecast.sh/calls/${id}?t=754`)).toEqual({ call: id, moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget(`https://codecast.sh/calls/${id}?turns=15-25`)).toEqual({ call: id, moment: { kind: "line", from: 15, to: 25 } });
    expect(parseSnapTarget("https://codecast.sh/tasks/ct-1")).toBeNull();
  });

  test("anything else is refused", () => {
    for (const bad of ["", "cl-42@12:99", "cl-42@soon", "cl-42:abc", "cl 42", "@12:34", "cl-42:"]) {
      expect(parseSnapTarget(bad)).toBeNull();
    }
  });
});

describe("time and names", () => {
  test("a line's frame is a whole second just inside it", () => {
    expect(lineFrameMs({ t0: 70_000, t1: 74_000 })).toBe(71_000);
    expect(lineFrameMs({ t0: 70_100, t1: 74_000 })).toBe(71_000);
    expect(lineFrameMs({ t0: 70_800, t1: 74_000 })).toBe(72_000);
    // Too short to reach the next second: the line's own start.
    expect(lineFrameMs({ t0: 70_800, t1: 71_200 })).toBe(70_800);
  });

  test("file clocks and names", () => {
    expect(clockForName(7_400)).toBe("0m07s");
    expect(clockForName(s(754))).toBe("12m34s");
    expect(clockForName(s(3723))).toBe("1h02m03s");
    expect(frameFileName("cl-42", s(754), "screen")).toBe("cl-42_12m34s_screen.png");
    expect(frameFileName("cl-42", s(754), "composite", true)).toBe("cl-42_12m34s_composite_live.png");
  });

  test("lineAt: the line under the moment, the last one in a short silence, nothing in a long one", () => {
    const segs = [
      { seq: 1, speaker_name: "Ana", text: "hi", t0: 0, t1: 2000 },
      { seq: 2, speaker_name: "Bo", text: "look at this", t0: 5000, t1: 9000 },
    ];
    expect(lineAt(segs, 6000)).toEqual({ seg: segs[1], during: true });
    expect(lineAt(segs, 12_000)).toEqual({ seg: segs[1], during: false });
    expect(lineAt(segs, 60_000)).toBeNull();
    expect(lineAt([], 0)).toBeNull();
  });
});

describe("output paths", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-out-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const frames = [
    { name: "cl-42_0m10s_screen.png", atMs: 10_000 },
    { name: "cl-42_0m20s_screen.png", atMs: 20_000 },
  ];

  test("no --out: the scratch directory, by frame name", () => {
    expect(outputPaths(frames, undefined, (n) => `/scratch/${n}`)).toEqual(["/scratch/cl-42_0m10s_screen.png", "/scratch/cl-42_0m20s_screen.png"]);
  });

  test("a directory, created when missing", () => {
    const out = path.join(dir, "frames");
    expect(outputPaths(frames, out)).toEqual([path.join(out, frames[0].name), path.join(out, frames[1].name)]);
    expect(fs.statSync(out).isDirectory()).toBe(true);
  });

  test("a file: itself for one frame, its stem plus the moment for several", () => {
    const file = path.join(dir, "shot.png");
    expect(outputPaths(frames.slice(0, 1), file)).toEqual([file]);
    expect(outputPaths(frames, file)).toEqual([path.join(dir, "shot_0m10s.png"), path.join(dir, "shot_0m20s.png")]);
  });

  test("two frames that would share a name are told apart", () => {
    const same = [frames[0], { ...frames[0] }];
    expect(outputPaths(same, undefined, (n) => `/s/${n}`)).toEqual(["/s/cl-42_0m10s_screen.png", "/s/cl-42_0m10s_screen-2.png"]);
  });
});

describe("what was recorded", () => {
  const recs = [
    { id: "c1", kind: "composite" as const, status: "ready" as const, started_at: T + min(1), duration_ms: min(4), run_id: "r1", url: "u", live_frame_url: null },
    { id: "s1", kind: "screen" as const, status: "ready" as const, started_at: T + min(2), duration_ms: min(1), participant_name: "Ana", run_id: "r1", url: "u", live_frame_url: null },
    { id: "c2", kind: "composite" as const, status: "failed" as const, started_at: T + min(8), duration_ms: min(1), run_id: "r2", url: null, live_frame_url: null },
  ];

  test("spans in call time, failed files left out", () => {
    const spans = recordedSpans(recs, T, T + min(30));
    expect(describeSpans(spans)).toBe("1:00-5:00 the room, 2:00-3:00 Ana's screen");
  });

  test("the nearest moment that will succeed", () => {
    const spans = recordedSpans(recs, T, T + min(30));
    expect(nearestRecordedMs(spans, min(7))).toBe(min(5) - 1000);
    expect(nearestRecordedMs(spans, s(10))).toBe(min(1));
    expect(nearestRecordedMs(spans, min(3))).toBe(min(3));
    expect(nearestRecordedMs([], 0)).toBeNull();
  });
});

describe("scene changes", () => {
  test("parses ffmpeg's metadata log", () => {
    const log = [
      "[Parsed_metadata_2 @ 0xcb6c02400] frame:0    pts:76800   pts_time:5",
      "[Parsed_metadata_2 @ 0xcb6c02400] lavfi.scene_score=0.400000",
      "frame=    1 fps=0.5 q=-0.0 size=N/A time=00:00:00.00 bitrate=N/A speed=   0x\r[Parsed_metadata_2 @ 0xcb6c02400] frame:1    pts:184320  pts_time:12.5",
      "[Parsed_metadata_2 @ 0xcb6c02400] lavfi.scene_score=0.906823",
    ].join("\n");
    expect(parseSceneScores(log)).toEqual([
      { atMs: 5000, score: 0.4 },
      { atMs: 12_500, score: 0.906823 },
    ]);
  });

  test("picks the biggest changes, spaced, in time order, with each stretch's first picture", () => {
    const cands = [
      { atMs: 0, score: Infinity },
      { atMs: 5000, score: 0.4 },
      { atMs: 5500, score: 0.5 },
      { atMs: 12_000, score: 0.9 },
      { atMs: 13_000, score: 0.01 },
      { atMs: 20_000, score: 0.6 },
    ];
    expect(pickSceneMoments(cands, { max: 8 })).toEqual([0, 5500, 12_000, 20_000]);
    expect(pickSceneMoments(cands, { max: 2 })).toEqual([0, 12_000]);
    expect(pickSceneMoments([{ atMs: 3000, score: 0.01 }], { max: 8 })).toEqual([]);
  });
});

describe("ffmpeg arguments", () => {
  test("a frame: input seek before -i, one frame out", () => {
    const args = frameArgs("https://bucket/x.mp4?sig", 754_250, "/o/f.png");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("754.250");
    expect(args.slice(-2)).toEqual(["-y", "/o/f.png"]);
    expect(args).toContain("-frames:v");
    expect(frameArgs("https://live.jpeg", null, "/o/f.jpg")).not.toContain("-ss");
    expect(frameArgs("https://live.jpeg", null, "/o/f.jpg")).toContain("-q:v");
  });

  test("a scene pass: keyframes only, in the file's own clock", () => {
    const args = sceneArgs("https://bucket/s.mp4", 30_000, 90_000);
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-copyts");
    expect(args[args.indexOf("-ss") + 1]).toBe("30.000");
    expect(args[args.indexOf("-t") + 1]).toBe("90.000");
  });

  test("failures read as what happened", () => {
    expect(ffmpegFailure("Server returned 403 Forbidden (access denied)", false)).toContain("ten minutes");
    expect(ffmpegFailure("Server returned 404 Not Found", false)).toContain("missing");
    expect(ffmpegFailure("", true)).toContain("too long");
    expect(ffmpegFailure("[in#0 @ 0x1] Invalid data found when processing input", false)).toBe(
      "ffmpeg could not read the recording: Invalid data found when processing input",
    );
  });
});

// ── The whole command, against a fake server and a fake ffmpeg ──────────

const segments = [
  { seq: 1, speaker_name: "Ana", text: "Let me share my screen.", t0: s(60), t1: s(63) },
  { seq: 2, speaker_name: "Ana", text: "This is the header we talked about.", t0: s(130), t1: s(136) },
  { seq: 3, speaker_name: "Bo", text: "And the footer?", t0: s(170), t1: s(172) },
  { seq: 4, speaker_name: "Ana", text: "Next slide has it.", t0: s(200), t1: s(204) },
];
const call = { _id: "k57call", short_id: "cl-42", title: "Design review", started_at: T, segments, last_seq: 4 };

function recordings(over: Partial<SnapRecordings> = {}, rows?: SnapRecordings["recordings"]): SnapRecordings {
  return {
    transcript_id: "k57call",
    short_id: "cl-42",
    call_started_at: T,
    call_ended_at: T + min(10),
    configured: true,
    server_now: T + min(20),
    recordings: rows ?? [
      { _id: "c1", run_id: "r1", kind: "composite", status: "ready", started_at: T + s(50), duration_ms: min(5), url: "https://r2/c1.mp4", live_frame_url: null },
      { _id: "s1", run_id: "r1", kind: "screen", status: "ready", started_at: T + s(120), duration_ms: s(100), participant_identity: "u_ana", participant_name: "Ana", url: "https://r2/s1.mp4", live_frame_url: null },
    ],
    ...over,
  };
}

function harness(recs: SnapRecordings | null, sceneLog = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-run-"));
  const calls: string[][] = [];
  const ffmpeg: FfmpegRunner = async (args) => {
    calls.push(args);
    if (args.includes("-copyts")) return { code: 0, stdout: "", stderr: sceneLog };
    fs.writeFileSync(args[args.length - 1], "png");
    return { code: 0, stdout: "", stderr: "" };
  };
  const posts: Array<[string, any]> = [];
  const deps = {
    post: async (route: string, body: any) => {
      posts.push([route, body]);
      return route === "/cli/calls/get" ? (recs ? call : null) : recs;
    },
    resolveCallId: async (ref: string) => (ref === "k57" ? "k57call" : ref),
    baseUrl: "https://codecast.sh",
    ffmpeg,
    scratch: (name: string) => path.join(dir, name),
    upload: async (file: string, alt: string) => ({ url: `https://img/${path.basename(file)}`, markdown: `![${alt}](https://img/${path.basename(file)})` }),
  };
  return { dir, calls, posts, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function refusal(p: Promise<unknown>): Promise<SnapError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SnapError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("snapCall", () => {
  test("a line said over a share: the share's own file, at the right offset, with its words and citation", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42:2", {}, h.deps);
    expect(res.frames).toHaveLength(1);
    const f = res.frames[0];
    // Line 2 starts 130s in; its frame is 131s; the share's file began 120s in.
    expect(f).toMatchObject({ ref: "cl-42@2:11", at_ms: s(131), kind: "screen", shows: "Ana's screen", offset_ms: s(11), live: false });
    expect(f.path).toBe(path.join(h.dir, "cl-42_2m11s_screen.png"));
    expect(f.line).toMatchObject({ ref: "cl-42:2", speaker: "Ana", during: true });
    expect(f.call_url).toBe("https://codecast.sh/calls/k57call?t=131");
    expect(h.calls[0]).toContain("https://r2/s1.mp4");
    expect(h.calls[0][h.calls[0].indexOf("-ss") + 1]).toBe("11.000");
    expect((fs.statSync(f.path).mode & 0o777).toString(8)).toBe("600");
    h.cleanup();
  });

  test("--composite takes the room file; a time outside any share falls back to the room with a note under --screen", async () => {
    const h = harness(recordings());
    const room = await snapCall("cl-42@2:11", { composite: true }, h.deps);
    expect(room.frames[0]).toMatchObject({ kind: "composite", shows: "the room", offset_ms: s(81) });
    const strict = await snapCall("cl-42@1:00", { screen: true }, h.deps);
    expect(strict.frames[0].kind).toBe("composite");
    expect(strict.notes.join(" ")).toContain("No screen share was recorded at 1:00");
    h.cleanup();
  });

  test("a range over a share: frames where the screen changed, bounded by --max", async () => {
    // The share file's own clock: changes at 20s and 55s into it, a flicker at 30s.
    const log = [
      "frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7",
      "frame:2 pts:2 pts_time:30", "lavfi.scene_score=0.01",
      "frame:3 pts:3 pts_time:55", "lavfi.scene_score=0.5",
    ].join("\n");
    const h = harness(recordings(), log);
    const res = await snapCall("cl-42:2-4", {}, h.deps);
    expect(res.range).toBe("where the shared screen changed");
    // Range is 131s..204s; the share covers 120s..220s. First picture at 131s,
    // then the changes at 140s and 175s.
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(131), s(140), s(175)]);
    expect(res.frames.every((f) => f.kind === "screen")).toBe(true);
    const scene = h.calls.find((a) => a.includes("-copyts"))!;
    expect(scene[scene.indexOf("-ss") + 1]).toBe("11.000");
    const two = await snapCall("cl-42:2-4", { max: 2 }, h.deps);
    expect(two.frames.map((f) => f.at_ms)).toEqual([s(131), s(140)]);
    h.cleanup();
  });

  test("a range with no share: evenly spaced room frames", async () => {
    const h = harness(recordings({}, [recordings().recordings[0]]));
    const res = await snapCall("cl-42:1-2", { max: 3, screen: true }, h.deps);
    expect(res.range).toBe("evenly spaced");
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(61), s(98.5), s(136)]);
    expect(res.notes.join(" ")).toContain("No screen share was recorded across these lines");
    expect(h.calls.some((a) => a.includes("-copyts"))).toBe(false);
    h.cleanup();
  });

  test("now: the live frame of a call still recording", async () => {
    const live = recordings({ call_ended_at: null, server_now: T + min(3) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: "https://r2/c1.jpeg" },
      { _id: "s1", run_id: "r1", kind: "screen", status: "recording", started_at: T + s(120), participant_name: "Ana", url: null, live_frame_url: "https://r2/s1.jpeg" },
    ]);
    const h = harness(live);
    const res = await snapCall("cl-42", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ live: true, kind: "screen", at_ms: min(3), ref: "cl-42@3:00", offset_ms: null });
    expect(h.calls[0]).not.toContain("-ss");
    expect(h.calls[0]).toContain("https://r2/s1.jpeg");
    // A moment a few seconds ago is answered the same way; one minutes ago is not ready yet.
    expect((await snapCall("cl-42@2:55", {}, h.deps)).frames[0].live).toBe(true);
    expect((await refusal(snapCall("cl-42@1:30", {}, h.deps))).code).toBe("not_ready");
    h.cleanup();
  });

  test("--share uploads and carries the markdown", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42:2", { share: true }, h.deps);
    expect(res.frames[0].image?.markdown).toBe("![cl-42@2:11, Ana's screen (Design review)](https://img/cl-42_2m11s_screen.png)");
    h.cleanup();
  });

  test("a prefix resolves through the CLI; short and full ids go straight to the server", async () => {
    const h = harness(recordings());
    await snapCall("k57:2", {}, h.deps);
    expect(h.posts.map(([, b]) => b.call ?? b.transcript_id)).toEqual(["k57call", "k57call"]);
    h.cleanup();
  });

  test("refusals say what to do", async () => {
    const h = harness(recordings());
    expect((await refusal(snapCall(undefined, {}, h.deps))).code).toBe("bad_target");
    expect((await refusal(snapCall("cl-42@soon", {}, h.deps))).code).toBe("bad_target");
    expect((await refusal(snapCall("cl-42:2", { screen: true, composite: true }, h.deps))).code).toBe("bad_option");
    expect((await refusal(snapCall("cl-42:2-4", { max: "99" }, h.deps))).code).toBe("bad_option");

    const outside = await refusal(snapCall("cl-42@8:00", {}, h.deps));
    expect(outside.code).toBe("outside");
    expect(outside.message).toContain("Recorded: 0:50-5:50 the room, 2:00-3:40 Ana's screen");
    expect(outside.message).toContain("cast call snap cl-42@5:49");

    const noLine = await refusal(snapCall("cl-42:9", {}, h.deps));
    expect(noLine.code).toBe("no_line");
    expect(noLine.message).toContain("lines run 1-4");

    expect((await refusal(snapCall("cl-42", {}, h.deps))).code).toBe("not_live");
    h.cleanup();

    const none = harness(recordings({}, []));
    const notRecorded = await refusal(snapCall("cl-42:2", {}, none.deps));
    expect(notRecorded.code).toBe("not_recorded");
    expect(notRecorded.message).toContain("cast call cl-42 2");
    expect((await refusal(snapCall("cl-42:2", {}, harness(recordings({ configured: false }, [])).deps))).code).toBe("not_configured");
    none.cleanup();

    const failed = harness(recordings({}, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "failed", started_at: null, url: null, live_frame_url: null, error: "The recording never began." },
    ]));
    const f = await refusal(snapCall("cl-42:2", {}, failed.deps));
    expect(f.code).toBe("recording_failed");
    expect(f.message).toContain("The recording never began.");
    failed.cleanup();

    const missing = harness(null);
    expect((await refusal(snapCall("cl-42:2", {}, missing.deps))).code).toBe("not_found");
    missing.cleanup();
  });

  test("a grab past a file's last frame retries a second earlier; a broken read says why", async () => {
    const h = harness(recordings());
    let n = 0;
    const flaky: FfmpegRunner = async (args) => {
      n++;
      if (n === 2) fs.writeFileSync(args[args.length - 1], "png");
      return { code: 0, stdout: "", stderr: "" };
    };
    const res = await snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: flaky });
    expect(res.frames[0].path).toBeTruthy();
    expect(n).toBe(2);
    const broken: FfmpegRunner = async () => ({ code: 1, stdout: "", stderr: "Server returned 403 Forbidden" });
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: broken }));
    expect(err.code).toBe("ffmpeg_failed");
    expect(err.message).toContain("403");
    h.cleanup();
  });
});
