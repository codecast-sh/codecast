import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { FRAME_SHARE_REFUSED_WORDS } from "@codecast/shared/contracts";
import { installCommandFor, installHintFor } from "./proc.js";
import {
  callVideoSpans,
  clockForName,
  describeSpans,
  firstRecordedWithin,
  frameArgs,
  frameFileName,
  ffmpegFailure,
  ffmpegDidNotRun,
  formatSnapResult,
  lineAt,
  nearestRecordedMs,
  outputPaths,
  parseSceneScores,
  parseSnapTarget,
  parseSnapTime,
  pickSceneMoments,
  probeTimes,
  sceneArgs,
  probeArgs,
  shownTimes,
  ffmpegRunner,
  findFfmpeg,
  LOOKBACK_STEPS_MS,
  DROP_BLANK_FRAMES,
  serveSources,
  SignedSources,
  snapCall,
  SnapError,
  uncoveredParts,
  parseCrop,
  CROP_FORMS,
  parseTiles,
  cropRect,
  tileRects,
  lineFilmed,
  spanLines,
  describeSpansByLine,
  snapHint,
  noPictureNote,
  snapMomentRef,
  firstFilmedLine,
  SCENE_CHANGED,
  SCREEN_FRAME_GAP_MS,
  GRAB_CONCURRENCY,
  readableTiles,
  coveredParts,
  linesAround,
  saidBefore,
  spanSnaps,
  bestSpanSnap,
  linesSpan,
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
    for (const bad of ["", "cl-42@12:99", "cl-42@soon", "cl-42:abc", "cl 42", "@12:34", "cl-42:", "cl-42:1:02:03", "cl-42:15@now"]) {
      expect(parseSnapTarget(bad)).toBeNull();
    }
  });

  test("the moment as its own word: lines the way `cast call cl-42 15:25` reads them, anything else a time", () => {
    const line = (from: number, to = from) => ({ kind: "line" as const, from, to });
    expect(parseSnapTarget("cl-42", "15")).toEqual({ call: "cl-42", moment: line(15) });
    expect(parseSnapTarget("cl-42", "15-25")).toEqual({ call: "cl-42", moment: line(15, 25) });
    // A colon pair is lines, as the transcript printer has it; that it is also
    // a time is carried, so the answer can say how to write the time.
    expect(parseSnapTarget("cl-42", "15:25")).toEqual({ call: "cl-42", moment: line(15, 25), alsoTime: s(925) });
    expect(parseSnapTarget("cl-42", "@12:34")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget("cl-42@", "12:34")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget("cl-42", "754s")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget("cl-42", "1:02:03")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(3723) } });
    expect(parseSnapTarget("cl-42", "now")).toEqual({ call: "cl-42", moment: { kind: "now" } });
    expect(parseSnapTarget("k57abc", "3")).toEqual({ call: "k57abc", moment: line(3) });
    // Two moments, or a word that is neither, is refused.
    expect(parseSnapTarget("cl-42:3", "15")).toBeNull();
    expect(parseSnapTarget("cl-42", "soon")).toBeNull();
  });

  test("a colon pair in one word is lines too, and never swallows a time written with @", () => {
    expect(parseSnapTarget("cl-42:12:34")).toEqual({ call: "cl-42", moment: { kind: "line", from: 12, to: 34 }, alsoTime: s(754) });
    expect(parseSnapTarget("cl-42:30:15")).toEqual({ call: "cl-42", moment: { kind: "line", from: 15, to: 30 }, alsoTime: s(1815) });
    // 12:75 is no time, so there is nothing to suggest.
    expect(parseSnapTarget("cl-42:12:75")).toEqual({ call: "cl-42", moment: { kind: "line", from: 12, to: 75 } });
    expect(parseSnapTarget("cl-42@1:02:03")).toEqual({ call: "cl-42", moment: { kind: "time", atMs: s(3723) } });
  });
});

describe("time and names", () => {
  test("file clocks and names", () => {
    expect(clockForName(7_000)).toBe("0m07s");
    // A moment between two seconds keeps its part of a second.
    expect(clockForName(7_400)).toBe("0m07.4s");
    expect(clockForName(150_250)).toBe("2m30.25s");
    expect(clockForName(s(754))).toBe("12m34s");
    expect(clockForName(s(3723))).toBe("1h02m03s");
    expect(frameFileName("cl-42", s(754), "screen")).toBe("cl-42_12m34s_screen.png");
    expect(frameFileName("cl-42", s(754), "composite", true)).toBe("cl-42_12m34s_composite_live.png");
    // Part of a frame is named by its part, so a crop never writes over the
    // whole frame of the same moment, nor one crop over another.
    expect(frameFileName("cl-42", s(754), "screen", false, parseCrop("tl"))).toBe("cl-42_12m34s_screen_top-left.png");
    expect(frameFileName("cl-42", s(754), "screen", false, parseCrop("0,0,50%,25%"))).toBe("cl-42_12m34s_screen_x0y0w50ph25p.png");
    expect(frameFileName("cl-42", s(754), "screen", false, parseCrop("10,20,960,540"))).toBe("cl-42_12m34s_screen_x10y20w960h540.png");
    const whole = frameFileName("cl-42", s(754), "screen");
    const names = [whole, frameFileName("cl-42", s(754), "screen", false, parseCrop("top-left")), frameFileName("cl-42", s(754), "screen", false, parseCrop("bottom-right"))];
    expect(new Set(outputPaths(names.map((name) => ({ name, atMs: s(754) })), undefined, (n) => `/s/${n}`)).size).toBe(3);
  });

  test("lineAt: the line under the moment, the last one in a short silence, nothing in a long one", () => {
    const segs = [
      { seq: 1, speaker_name: "Ana", text: "hi", t0: 0, t1: 2000 },
      { seq: 2, speaker_name: "Bo", text: "look at this", t0: 5000, t1: 9000 },
    ];
    expect(lineAt(segs, 6000)).toEqual({ seg: segs[1], during: true });
    // A line's end is exclusive, as it is on the call page.
    expect(lineAt(segs, 9000)).toEqual({ seg: segs[1], during: false });
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

  test("an image type other than png or jpg is refused, not made a directory", () => {
    for (const bad of ["frame.webp", "shot.gif", "a.tiff"]) {
      expect(() => outputPaths(frames, path.join(dir, bad))).toThrow("-o takes a .png or .jpg file, or a directory");
      expect(fs.existsSync(path.join(dir, bad))).toBe(false);
    }
    // A new directory with a dot in its name is named with a trailing slash.
    expect(outputPaths(frames.slice(0, 1), path.join(dir, "v1.2") + "/")).toEqual([path.join(dir, "v1.2", frames[0].name)]);
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

  const rowsOf = (list: typeof recs) => list.map(({ id, ...r }) => ({ ...r, _id: id }));

  test("spans in call time, failed files left out", () => {
    const spans = callVideoSpans({ recordings: rowsOf(recs), call_started_at: T, server_now: T + min(30) });
    expect(describeSpans(spans)).toBe("1:00-5:00 the room, 2:00-3:00 Ana's screen");
  });

  test("the first recorded second inside a line, and the stretches nothing covers", () => {
    const spans = callVideoSpans({ recordings: rowsOf(recs), call_started_at: T, server_now: T + min(30) });
    expect(firstRecordedWithin(spans, s(57), s(64))).toBe(min(1));
    expect(firstRecordedWithin(spans, s(20), s(40))).toBeNull();
    expect(uncoveredParts([{ fromMs: 10, toMs: 20 }, { fromMs: 15, toMs: 30 }, { fromMs: 50, toMs: 60 }], 0, 70)).toEqual([[0, 10], [30, 50], [60, 70]]);
    expect(uncoveredParts([{ fromMs: 0, toMs: 100 }], 10, 20)).toEqual([]);
  });

  test("the nearest moment that will succeed", () => {
    const spans = callVideoSpans({ recordings: rowsOf(recs), call_started_at: T, server_now: T + min(30) });
    // Past an end, inside it by NEAREST_END_INSET_MS: a file's last second
    // is where filler and a share's ending sit.
    expect(nearestRecordedMs(spans, min(7))).toBe(min(5) - 2000);
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
    // With room for two, the cut farthest from the first picture: the
    // frames cover the stretch rather than bunch at its biggest change.
    expect(pickSceneMoments(cands, { max: 2 })).toEqual([0, 20_000]);
    // A change below the cut threshold is still a change (the scene pass
    // logs nothing else), so it is a frame when the budget has room.
    expect(pickSceneMoments([{ atMs: 3000, score: 0.01 }], { max: 8 })).toEqual([3000]);
  });

  test("a screen changing a little at a time is followed across the stretch, the whole budget spent", () => {
    // Code typed a line a second for a minute: every keyframe differs from
    // the last picture kept, and none is a cut (measured scores peak near
    // 0.001). The frames spread over the minute rather than stopping at its
    // first picture.
    const cands = [{ atMs: 0, score: Infinity }, ...Array.from({ length: 59 }, (_, i) => ({ atMs: (i + 1) * 1000, score: 0.0004 }))];
    const picked = pickSceneMoments(cands, { max: 8 });
    expect(picked).toHaveLength(8);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(59_000);
    const gaps = picked.slice(1).map((p, i) => p - picked[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(SCREEN_FRAME_GAP_MS);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000);
    // Cuts still come first: with room for two, the slide change wins over
    // the gradual ones.
    expect(pickSceneMoments([...cands, { atMs: 30_500, score: 0.3 }], { max: 2 })).toEqual([0, 30_500]);
    // A screen that never changed is one frame, never copies of it.
    expect(pickSceneMoments([{ atMs: 0, score: Infinity }], { max: 8 })).toEqual([0]);
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

  test("a frame found by a wide probe is grabbed from where that probe read, picked by trim", () => {
    // cl-107's screen file decodes the frame shown at 8.65 s ahead of the
    // 5.93 s keyframe, so a seek straight to 8.653 never sees it.
    const args = frameArgs("x", 8_653, "/o/f.png", 0);
    expect(args[args.indexOf("-ss") + 1]).toBe("0.000");
    expect(args[args.indexOf("-vf") + 1]).toBe("trim=start=8.653,showinfo");
    const direct = frameArgs("x", 8_653, "/o/f.png");
    expect(direct[direct.indexOf("-ss") + 1]).toBe("8.653");
    expect(direct[direct.indexOf("-vf") + 1]).toBe("showinfo");
  });

  test("a scene pass: keyframes only, on the file's clock measured from its start", () => {
    const args = sceneArgs("https://bucket/s.mp4", 30_000, 90_000);
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-copyts");
    // An egress file can start at a nonzero timestamp; the frame grab's seek
    // is from the file's start, so the scene times must be too.
    expect(args).toContain("-start_at_zero");
    expect(args[args.indexOf("-ss") + 1]).toBe("30.000");
    expect(args[args.indexOf("-t") + 1]).toBe("90.000");
  });

  test("LiveKit's black filler is never a picture: probes and scene passes drop it before anything reads a frame", () => {
    // cl-117: a stalled share was written as solid black between its real
    // frames, and a probe that counted those landed the snap on black.
    expect(DROP_BLANK_FRAMES).toContain("signalstats");
    expect(DROP_BLANK_FRAMES).toContain("metadata=mode=select:key=lavfi.signalstats.YMAX");
    const probe = probeArgs("x", 11_000, 2_000);
    const pv = probe[probe.indexOf("-vf") + 1];
    // One tap sees every frame (what a <video> shows), the last only pictures.
    expect(pv.indexOf("showinfo")).toBeLessThan(pv.indexOf(DROP_BLANK_FRAMES));
    expect(pv.indexOf(DROP_BLANK_FRAMES)).toBeLessThan(pv.lastIndexOf("showinfo"));
    const scene = sceneArgs("x", 0, 10_000);
    const sv = scene[scene.indexOf("-vf") + 1];
    // Dropped before scoring, so a stall is no change rather than two cuts.
    expect(sv.indexOf(DROP_BLANK_FRAMES)).toBeLessThan(sv.indexOf("select='gte(scene,0)'"));
    // Scored against the frame before, then kept only when it differs from
    // the last picture kept, so a gradual change adds up to one.
    expect(sv.indexOf("select='gte(scene,0)'")).toBeLessThan(sv.indexOf(SCENE_CHANGED));
    expect(sv.indexOf(SCENE_CHANGED)).toBeLessThan(sv.indexOf("metadata=print:key=lavfi.scene_score"));
  });

  test("failures read as what happened", () => {
    expect(ffmpegFailure("Server returned 403 Forbidden (access denied)", false)).toContain("signed again");
    expect(ffmpegFailure("Server returned 404 Not Found", false)).toContain("missing");
    expect(ffmpegFailure("", true)).toContain("too long");
    const leaky = ffmpegFailure("Error opening input file https://acct.r2.cloudflarestorage.com/b/calls/x.mp4?X-Amz-Signature=abc.", false);
    expect(leaky).not.toContain("Signature");
    expect(leaky).toBe("ffmpeg could not read the recording: Error opening input file <recording>");
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

function harness(recs: SnapRecordings | null, sceneLog: string | ((args: string[]) => { code: number | null; stderr: string }) = "", theCall: typeof call = call) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-run-"));
  const calls: string[][] = [];
  const ffmpeg: FfmpegRunner = async (args) => {
    calls.push(args);
    if (args.includes("-skip_frame")) {
      const r = typeof sceneLog === "function" ? sceneLog(args) : { code: 0, stderr: sceneLog };
      return { stdout: "", ...r };
    }
    // A probe: by default a dense file, with a frame exactly at the moment
    // (trim's end is the moment plus 1 ms).
    const trim = args.find((a) => a.startsWith("trim=end="));
    if (trim) {
      const end = Number(/trim=end=([\d.]+)/.exec(trim)![1]);
      return { code: 0, stdout: "", stderr: `[Parsed_showinfo_1] n:0 pts:1 pts_time:${(end - 0.001).toFixed(3)}` };
    }
    fs.writeFileSync(args[args.length - 1], "png");
    return { code: 0, stdout: "", stderr: "" };
  };
  const posts: Array<[string, any]> = [];
  const shared: Array<[string, string]> = [];
  const progress: string[] = [];
  /** The runs that wrote a frame (a probe writes nothing). */
  const grabs = () => calls.filter((a) => a.includes("-frames:v"));
  const deps = {
    post: async (route: string, body: any) => {
      posts.push([route, body]);
      return route === "/cli/calls/get" ? (recs ? theCall : null) : recs;
    },
    resolveCallId: async (ref: string) => (ref === "k57" ? "k57call" : ref),
    baseUrl: "https://codecast.sh",
    ffmpeg,
    scratch: (name: string) => path.join(dir, name),
    share: async (file: string, recordingId: string, alt: string) => {
      shared.push([path.basename(file), recordingId]);
      return { url: `https://img/${path.basename(file)}`, markdown: `![${alt}](https://img/${path.basename(file)})` };
    },
    // The signed links straight, so a test reads which file ffmpeg was
    // pointed at; the proxy has its own test below.
    serveSources: async () => ({
      urlFor: (id: string, live: boolean) => {
        const r = recs!.recordings.find((x) => x._id === id)!;
        return (live ? r.live_frame_url : r.url)!;
      },
      close: async () => {},
    }),
    progress: (line: string) => progress.push(line),
  };
  return { dir, calls, grabs, posts, shared, progress, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
    // The link opens on the picture: Ana's screen, not the room.
    expect(f.call_url).toBe("https://codecast.sh/calls/cl-42?t=131&view=screen:u_ana");
    // The probe looks back from the moment; the grab reads from where the
    // probe did and picks the frame it found (a millisecond early, onto that
    // frame and not the next).
    expect(h.calls[0]).toContain("https://r2/s1.mp4");
    expect(h.calls[0][h.calls[0].indexOf("-ss") + 1]).toBe("9.000");
    const grab = h.grabs()[0];
    expect(grab[grab.indexOf("-ss") + 1]).toBe("9.000");
    expect(grab[grab.indexOf("-vf") + 1]).toBe("trim=start=10.999,showinfo");
    expect((fs.statSync(f.path).mode & 0o777).toString(8)).toBe("600");
    h.cleanup();
  });

  test("--composite takes the room file; --screen refuses a moment no share covers, naming one that works", async () => {
    const h = harness(recordings());
    const room = await snapCall("cl-42@2:11", { composite: true }, h.deps);
    expect(room.frames[0]).toMatchObject({ kind: "composite", shows: "the room", offset_ms: s(81) });
    // Without a flag, a moment outside the share is simply the room.
    expect((await snapCall("cl-42@1:00", {}, h.deps)).frames[0].kind).toBe("composite");
    const strict = await refusal(snapCall("cl-42@1:00", { screen: true }, h.deps));
    expect(strict.code).toBe("no_screen");
    expect(strict.message).toContain("Screens recorded: 2:00-3:40 Ana's screen");
    expect(strict.message).toContain("cast call snap cl-42@2:00 --screen");
    expect((await snapCall("cl-42@2:11", { screen: true }, h.deps)).frames[0].kind).toBe("screen");
    h.cleanup();
  });

  test("--composite where only a share's file reaches: the share, and a note that it is not the room", async () => {
    // The share's file began 10s before the room's.
    const h = harness(recordings({}, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "ready", started_at: T + s(130), duration_ms: min(3), url: "https://r2/c1.mp4", live_frame_url: null },
      { _id: "s1", run_id: "r1", kind: "screen", status: "ready", started_at: T + s(120), duration_ms: s(100), participant_identity: "u_ana", participant_name: "Ana", url: "https://r2/s1.mp4", live_frame_url: null },
    ]));
    const early = await snapCall("cl-42@2:05", { composite: true }, h.deps);
    expect(early.frames[0]).toMatchObject({ kind: "screen", shows: "Ana's screen" });
    expect(early.notes).toEqual(["The room was not being recorded at 2:05, so that frame is the shared screen instead."]);
    // Once the room's file has begun, the room it is, and nothing to say.
    const later = await snapCall("cl-42@2:15", { composite: true }, h.deps);
    expect(later.frames[0].kind).toBe("composite");
    expect(later.notes).toEqual([]);
    h.cleanup();
  });

  test("a range over a share: frames where the screen changed, bounded by --max", async () => {
    // The share file's own clock: cuts at 20s and 55s into it, a small change at 30s.
    const log = [
      "frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7",
      "frame:2 pts:2 pts_time:30", "lavfi.scene_score=0.01",
      "frame:3 pts:3 pts_time:55", "lavfi.scene_score=0.5",
    ].join("\n");
    const h = harness(recordings(), log);
    const res = await snapCall("cl-42:2-4", {}, h.deps);
    expect(res.range).toBe("scene");
    // Range is 131s..204s; the share covers 120s..220s. First picture at 131s,
    // the cuts at 140s and 175s, and with frames to spare the small change
    // at 150s.
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(131), s(140), s(150), s(175)]);
    expect(res.frames.every((f) => f.kind === "screen")).toBe(true);
    const scene = h.calls.find((a) => a.includes("-skip_frame"))!;
    expect(scene[scene.indexOf("-ss") + 1]).toBe("11.000");
    const two = await snapCall("cl-42:2-4", { max: 2 }, h.deps);
    expect(two.frames.map((f) => f.at_ms)).toEqual([s(131), s(175)]);
    // Three changes, one shown: the reader is told, and how to see them all.
    expect(two.changes_found).toBe(3);
    expect(two.notes).toContain("The screen changed 3 times across these lines; these 2 frames are spread through them. --max 4, or a narrower line range, shows every change.");
    expect(res.changes_found).toBe(3);
    expect(res.notes.join(" ")).not.toContain("The screen changed");
    h.cleanup();
  });

  test("range frames land on whole seconds, so each citation names the frame it prints beside", async () => {
    const base = recordings();
    const offBeat = recordings({}, [base.recordings[0], { ...base.recordings[1], started_at: T + 120_400 }]);
    const h = harness(offBeat, ["frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:2-4", {}, h.deps);
    // The change 20s into a file that began 120.4s in is 140.4s; its frame is 141s.
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(131), s(141)]);
    expect(res.frames.map((f) => f.ref)).toEqual(["cl-42@2:11", "cl-42@2:21"]);
    h.cleanup();
  });

  test("a range with no share: evenly spaced room frames", async () => {
    const h = harness(recordings({}, [recordings().recordings[0]]));
    const res = await snapCall("cl-42:1-2", { max: 3 }, h.deps);
    expect(res.range).toBe("even");
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(61), s(99), s(136)]);
    expect(h.calls.some((a) => a.includes("-skip_frame"))).toBe(false);
    // --screen asks for a share, and there is none to give.
    const strict = await refusal(snapCall("cl-42:1-2", { screen: true }, h.deps));
    expect(strict.code).toBe("no_screen");
    expect(strict.message).toContain("Nobody shared a screen while cl-42 was recorded");
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

  test("now, with a share being recorded: the room's live picture; --screen says when the share's own can be read", async () => {
    // The server writes a live picture for the room's file only (LiveKit
    // will not start a screen file asked for pictures too).
    const live = recordings({ call_ended_at: null, server_now: T + min(3) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: "https://r2/c1.jpeg" },
      { _id: "s1", run_id: "r1", kind: "screen", status: "recording", started_at: T + s(120), participant_name: "Ana", url: null, live_frame_url: null },
    ]);
    const h = harness(live);
    const res = await snapCall("cl-42", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ live: true, kind: "composite", offset_ms: null });
    expect(h.calls[0]).toContain("https://r2/c1.jpeg");
    const strict = await refusal(snapCall("cl-42", { screen: true }, h.deps));
    expect(strict.code).toBe("not_live");
    expect(strict.message).toBe("A shared screen in cl-42 is being recorded, and its own picture can be read once the recording is saved. For the call as it is now, with the share in it, drop --screen: cast call snap cl-42");
    expect(strict.details.try).toEqual(["cast call snap cl-42"]);
    h.cleanup();
  });

  test("now, for a reader outside the call: the server keeps the live picture back and the refusal says to join", async () => {
    const kept = recordings({ call_ended_at: null, server_now: T + min(3), live_watch: false }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: null },
    ]);
    const h = harness(kept);
    const now = await refusal(snapCall("cl-42", {}, h.deps));
    expect(now.code).toBe("not_live");
    expect(now.message).toBe(
      "cl-42 is being recorded right now, and only someone in the call sees it as it is now. Join the call to see it live; the video can be snapped here once the recording stops.",
    );
    // A moment seconds ago is not offered the live picture either.
    const recent = await refusal(snapCall("cl-42@2:55", {}, h.deps));
    expect(recent.code).toBe("not_ready");
    expect(recent.message).toContain("Until then only someone in the call sees it, live.");
    expect(recent.details.try).toBeUndefined();
    expect(h.calls).toEqual([]);
    h.cleanup();
  });

  test("--share uploads and carries the markdown; the public image's alt names the moment, not the call's title", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42:2", { share: true }, h.deps);
    expect(res.frames[0].image?.markdown).toBe("![cl-42@2:11, Ana's screen](https://img/cl-42_2m11s_screen.png)");
    // Shared from the file it came from, so deleting the recording deletes
    // it; the JSON's image carries no storage id.
    expect(h.shared).toEqual([["cl-42_2m11s_screen.png", "s1"]]);
    expect(Object.keys(res.frames[0].image!)).toEqual(["url", "markdown"]);
    h.cleanup();
  });

  // A picture goes public only from whoever may publish it (the server's
  // mayShareFrame); anyone else is pointed at the reference, which renders
  // for the call's readers alone, and a range is refused once, not per frame.
  test("--share refused by the server: once, saying who can and to cite the moment instead", async () => {
    const h = harness(recordings());
    let tries = 0;
    const atMs: number[] = [];
    const refused = {
      ...h.deps,
      share: async (_f: string, _r: string, _a: string, at: number) => {
        tries++;
        atMs.push(at);
        throw new Error(FRAME_SHARE_REFUSED_WORDS);
      },
    };
    const one = await snapCall("cl-42:2", { share: true }, refused);
    expect(atMs).toEqual([131_000]);
    expect(one.frames[0].image).toBeUndefined();
    expect(one.frames[0].image_error).toContain("cite cl-42@2:11 in a message instead");
    expect(one.notes.join(" ")).toContain("Not shared by link. Only whoever recorded this call");
    tries = 0;
    const room = harness(recordings({}, [recordings().recordings[0]]));
    const range = await snapCall("cl-42:1-2", { max: 3, share: true }, { ...room.deps, share: refused.share });
    room.cleanup();
    expect(range.frames.length).toBeGreaterThan(1);
    expect(tries).toBe(1);
    expect(range.frames.every((f) => f.image_error?.includes(FRAME_SHARE_REFUSED_WORDS))).toBe(true);
    expect(range.notes.filter((n) => n.includes("Not shared by link")).length).toBe(1);
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
    expect(outside.message).toContain("cast call snap cl-42@5:48");

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

  test("a quiet screen: the probe looks further back until it finds the picture on screen; a broken read says why", async () => {
    // Line 2's frame is 11 s into Ana's file. Her screen last changed 6.5 s
    // in: nothing in the 2 s before the moment, so the probe widens.
    const h = harness(recordings());
    const seen: string[][] = [];
    const sparse: FfmpegRunner = async (args) => {
      seen.push(args);
      if (args.includes("-frames:v")) {
        fs.writeFileSync(args[args.length - 1], "png");
        return { code: 0, stdout: "", stderr: "[Parsed_showinfo_0] n:0 pts:6 pts_time:6.500" };
      }
      const from = Number(args[args.indexOf("-ss") + 1]);
      return { code: 0, stdout: "", stderr: from <= 6.5 ? "[Parsed_showinfo_1] n:0 pts:5 pts_time:5.000\n[Parsed_showinfo_1] n:1 pts:6 pts_time:6.500" : "" };
    };
    const res = await snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: sparse });
    expect(seen.map((a) => a[a.indexOf("-ss") + 1])).toEqual([
      ((11_000 - LOOKBACK_STEPS_MS[0]) / 1000).toFixed(3),
      ((11_000 - LOOKBACK_STEPS_MS[1]) / 1000 > 0 ? (11_000 - LOOKBACK_STEPS_MS[1]) / 1000 : 0).toFixed(3),
      "0.000",
    ]);
    expect(seen[2][seen[2].indexOf("-vf") + 1]).toBe("trim=start=6.499,showinfo");
    // The picture from 6.5 s, never the next one after 11 s.
    expect(res.frames[0]).toMatchObject({ at_ms: s(131), offset_ms: 6500, citation_matches: true });
    expect(res.notes).toContain("No new picture of Ana's screen was written after 2:06, so the frame for 2:11 is the one on screen since then.");

    const broken: FfmpegRunner = async () => ({ code: 1, stdout: "", stderr: "Server returned 403 Forbidden" });
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: broken }));
    expect(err.code).toBe("ffmpeg_failed");
    expect(err.message).toContain("403");
    h.cleanup();
  });

  test("a file with no picture at all still refuses", async () => {
    const h = harness(recordings());
    const empty: FfmpegRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: empty }));
    expect(err.code).toBe("ffmpeg_failed");
    expect(err.message).toBe("ffmpeg found no frame at 2:11 in the recording.");
    h.cleanup();
  });

  test("no ffmpeg on the machine: refused with how to install it, and a call with no video never asks for it", async () => {
    let looked = 0;
    const find = () => {
      looked++;
      return null;
    };
    const h = harness(recordings());
    const missing = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: undefined, findFfmpeg: find }));
    expect(missing.code).toBe("ffmpeg_missing");
    expect(missing.message).toBe(`A frame is read out of the recording with ffmpeg, which is not installed. ${installHintFor("ffmpeg", { winget: "Gyan.FFmpeg" })}`);
    const install = installCommandFor("ffmpeg");
    expect(missing.details.try ?? []).toEqual(install ? [install] : []);
    expect(looked).toBe(1);
    h.cleanup();

    looked = 0;
    const none = harness(recordings({}, []));
    expect((await refusal(snapCall("cl-42:2", {}, { ...none.deps, ffmpeg: undefined, findFfmpeg: find }))).code).toBe("not_recorded");
    expect(looked).toBe(0);
    none.cleanup();
  });

  test("an ffmpeg that is installed but does not run is refused as ffmpeg, never as the recording, and a range stops at it", async () => {
    const reinstall = installCommandFor("ffmpeg", { reinstall: true });
    const h = harness(recordings());
    let runs = 0;
    const unrunnable: FfmpegRunner = async () => {
      runs++;
      return { code: -1, stdout: "", stderr: "spawn EACCES" };
    };
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: unrunnable }));
    expect(err.code).toBe("ffmpeg_missing");
    expect(err.message).toBe(
      `ffmpeg at ffmpeg is installed but does not run (spawn EACCES). ${reinstall ? `Reinstall it: ${reinstall}` : "Reinstall it with your system package manager."}`,
    );
    expect(err.details.try ?? []).toEqual(reinstall ? [reinstall] : []);
    // Not run a second time the way a cut-short read is.
    expect(runs).toBe(1);

    // A range of evenly spaced room frames: the first refusal ends it.
    runs = 0;
    const dyld: FfmpegRunner = async () => {
      runs++;
      return {
        code: 134,
        stdout: "",
        stderr: "dyld[4242]: Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib\n  Referenced from: /opt/homebrew/bin/ffmpeg\n  Reason: tried: '/opt/homebrew/opt/x265/lib/libx265.215.dylib' (no such file)",
      };
    };
    const range = await refusal(snapCall("cl-42:1-4", { composite: true, max: 4 }, { ...h.deps, ffmpeg: dyld }));
    expect(range.code).toBe("ffmpeg_missing");
    expect(range.message).toContain("(Library not loaded: /opt/homebrew/opt/x265/lib/libx265.215.dylib)");
    expect(runs).toBeLessThanOrEqual(GRAB_CONCURRENCY);
    h.cleanup();
  });

  test("ffmpegDidNotRun: the binary failing to start, apart from ffmpeg failing on a file", () => {
    expect(ffmpegDidNotRun({ code: -1, stdout: "", stderr: "Error: spawn /opt/homebrew/bin/ffmpeg EACCES" })).toBe("spawn /opt/homebrew/bin/ffmpeg EACCES");
    expect(ffmpegDidNotRun({ code: 127, stdout: "", stderr: "ffmpeg: error while loading shared libraries: libx265.so.199: cannot open shared object file" })).toBe(
      "ffmpeg: error while loading shared libraries: libx265.so.199: cannot open shared object file",
    );
    expect(ffmpegDidNotRun({ code: 134, stdout: "", stderr: "" })).toBe("it aborted before reading anything");
    // ffmpeg's own words: the recording's problem, never a reinstall.
    expect(ffmpegDidNotRun({ code: 134, stdout: "", stderr: "[h264 @ 0x1] Assertion failed\nAborted" })).toBeNull();
    expect(ffmpegDidNotRun({ code: 1, stdout: "", stderr: "Server returned 403 Forbidden" })).toBeNull();
    expect(ffmpegDidNotRun({ code: null, stdout: "", stderr: "" })).toBeNull();
    expect(ffmpegDidNotRun({ code: 0, stdout: "", stderr: "dyld: warning" })).toBeNull();
  });

  test("the real runner: a file that cannot run, and a crash said as its signal, never as a timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-bin-"));
    const notExec = path.join(dir, "ffmpeg");
    fs.writeFileSync(notExec, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const h = harness(recordings());
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: undefined, findFfmpeg: () => notExec }));
    expect(err.code).toBe("ffmpeg_missing");
    expect(err.message).toStartWith(`ffmpeg at ${notExec} is installed but does not run (`);
    expect(err.message).toContain("EACCES");
    h.cleanup();

    const aborts = path.join(dir, "aborts");
    fs.writeFileSync(aborts, "#!/bin/sh\nkill -ABRT $$\n", { mode: 0o755 });
    const res = await ffmpegRunner(aborts)([], { timeoutMs: 10_000 });
    expect(res.code).toBe(134);
    expect(ffmpegDidNotRun(res)).toBe("it aborted before reading anything");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a probe: decodes from the lookback up to and including the moment, on the file's clock from its start", () => {
    const args = probeArgs("https://bucket/s.mp4", 11_000, 2_000);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("9.000");
    expect(args).toContain("-copyts");
    expect(args).toContain("-start_at_zero");
    expect(args[args.indexOf("-vf") + 1]).toBe(`trim=end=11.001,scale=320:-2,showinfo,${DROP_BLANK_FRAMES},showinfo`);
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
    // A lookback past the file's start reads from its start.
    expect(probeArgs("x", 1_000, 2_000)[probeArgs("x", 1_000, 2_000).indexOf("-ss") + 1]).toBe("0.000");
    // A frame grab carries the same clock, so the time it logs is comparable.
    const grab = frameArgs("x", 6_499, "/o/f.png");
    expect(grab).toContain("-copyts");
    expect(grab).toContain("-start_at_zero");
    expect(shownTimes("pts_time:14.328\nx pts_time:14.461333 y")).toEqual([14_328, 14_461]);
    expect(shownTimes("no frames")).toEqual([]);
  });

  test("the moment as a second word, the way an agent types it after `cast call cl-42 15:25`", async () => {
    const h = harness(recordings());
    expect((await snapCall("cl-42", {}, h.deps, "2")).frames[0].ref).toBe("cl-42@2:11");
    expect((await snapCall("cl-42", {}, h.deps, "@2:11")).frames[0]).toMatchObject({ ref: "cl-42@2:11", kind: "screen" });
    h.cleanup();
  });

  test("a colon pair could be lines or a time, so it is refused with both spellings rather than guessed", async () => {
    const h = harness(recordings());
    for (const [target, extra] of [["cl-42", "2:04"], ["cl-42:2:04", undefined]] as const) {
      const err = await refusal(snapCall(target, {}, h.deps, extra));
      expect(err.code).toBe("ambiguous_moment");
      expect(err.message).toContain("could be lines 2-4 or the time 2:04: write cl-42:2-4 for the lines, or cl-42@2:04 for the time.");
      expect(err.details.try).toEqual(["cast call snap cl-42:2-4", "cast call snap cl-42@2:04"]);
    }
    // Lines the call does not have: still the time hint, never "no line".
    const far = await refusal(snapCall("cl-42:12:34", {}, h.deps));
    expect(far.code).toBe("ambiguous_moment");
    expect(far.details.try).toContain("cast call snap cl-42@12:34");
    // Nothing read from the server or the recording before refusing.
    expect(h.calls).toHaveLength(0);
    h.cleanup();
  });

  test("a line that began just before the press is shown from its first recorded second", async () => {
    // Line 1 runs 1:00 to 1:03; the room's file starts 1.4s into it.
    const late = recordings({}, [{ ...recordings().recordings[0], started_at: T + s(61.4) }]);
    const h = harness(late);
    const res = await snapCall("cl-42:1", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ at_ms: s(62), ref: "cl-42@1:02", offset_ms: 600 });
    expect(res.notes.join(" ")).toContain("Line 1 began at 1:00, before it was being recorded; this frame is from 1:02, 2s into it.");
    // Recording stopped partway through the line: that is the reason given,
    // not a late start.
    const stopped = harness(recordings({}, [{ ...recordings().recordings[0], duration_ms: s(10.8) }]));
    const cut = await snapCall("cl-42:1", {}, stopped.deps);
    expect(cut.frames[0]).toMatchObject({ at_ms: s(60) });
    expect(cut.notes).toContain("Recording stopped at 1:00, during line 1; this frame is from 1:00.");
    stopped.cleanup();
    // A line wholly before the press still refuses, with the stretches that were.
    const early = harness(recordings({}, [{ ...recordings().recordings[0], started_at: T + s(65) }]));
    expect((await refusal(snapCall("cl-42:1", {}, early.deps))).code).toBe("outside");
    h.cleanup();
    early.cleanup();
  });

  test("a range a share covers only partly: the share's changes, and room frames for the rest", async () => {
    // Lines 1-4 run 1:01 to 3:24; Ana's screen covers 2:00 to 3:24 of it.
    const h = harness(recordings(), ["frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:1-4", { max: 4 }, h.deps);
    expect(res.range).toBe("mixed");
    expect(res.frames.map((f) => [f.at, f.kind])).toEqual([
      ["1:01", "composite"],
      ["2:00", "screen"],
      ["2:20", "screen"],
    ]);
    expect(formatSnapResult(res)).toContain("where Ana's screen changed, and evenly through the rest");
    h.cleanup();
  });

  test("lines that began before Record was pressed spend no frames on the stretch nothing filmed", async () => {
    // Record pressed at 1:50, line 1 said at 1:00: the room file runs from
    // 1:50, Ana's screen from 2:00. Every frame lands inside a file, and the
    // unfilmed start is said once rather than as missed frames.
    const [room, screen] = recordings().recordings;
    const h = harness(recordings({}, [{ ...room, started_at: T + s(110) }, screen]), ["frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:1-4", { max: 4 }, h.deps);
    expect(res.frames.every((f) => f.at_ms >= s(110))).toBe(true);
    expect(res.frames.map((f) => f.kind)).toContain("composite");
    expect(res.frames.map((f) => f.kind)).toContain("screen");
    expect(res.notes).toEqual(["Nothing was recorded 1:01-1:50, so the frames come from the rest of these lines."]);
    // With no screen at all, the room's frames spread over its own stretch.
    const roomOnly = harness(recordings({}, [{ ...room, started_at: T + s(110) }]));
    const even = await snapCall("cl-42:1-4", { max: 3 }, roomOnly.deps);
    expect(even.frames.map((f) => f.at)).toEqual(["1:50", "2:37", "3:24"]);
    // A call with no screen file at all may have had a share filmed only in
    // the room view, which even frames can step over: said once.
    expect(even.notes).toEqual([
      "Nothing was recorded 1:01-1:50, so the frames come from the rest of these lines.",
      "No screen was recorded on its own across these lines, so the room's frames are evenly spaced; a screen shared in the room view may have changed between them.",
    ]);
    h.cleanup();
    roomOnly.cleanup();
  });

  test("a scan that fails or would read too much is sampled evenly instead, and says so", async () => {
    const failing = harness(recordings(), () => ({ code: 1, stderr: "Server returned 403 Forbidden" }));
    const res = await snapCall("cl-42:2-4", { max: 3 }, failing.deps);
    expect(res.range).toBe("even");
    expect(res.frames.every((f) => f.kind === "screen")).toBe(true);
    expect(res.notes.join(" ")).toContain("Could not scan Ana's screen for changes");
    failing.cleanup();

    const base = recordings();
    const huge = harness(recordings({}, [base.recordings[0], { ...base.recordings[1], size_bytes: 40e9 }]));
    const big = await snapCall("cl-42:2-4", { max: 3 }, huge.deps);
    expect(huge.calls.some((a) => a.includes("-skip_frame"))).toBe(false);
    expect(big.notes.join(" ")).toContain("too long to scan for changes");
    huge.cleanup();
  });

  test("slow steps report progress, one line each", async () => {
    const h = harness(recordings(), ["frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7"].join("\n"));
    await snapCall("cl-42:2-4", {}, h.deps);
    expect(h.progress[0]).toBe("Reading 2:11-3:24 of Ana's screen for changes...");
    expect(h.progress.slice(1)).toEqual(["Frame 1/2 at 2:11", "Frame 2/2 at 2:20"]);
    h.cleanup();
  });

  test("a ready file the server could not sign is said so, never handed to ffmpeg", async () => {
    const base = recordings();
    const h = harness(recordings({}, base.recordings.map((r) => ({ ...r, url: null }))));
    const err = await refusal(snapCall("cl-42:2", {}, h.deps));
    expect(err.code).toBe("not_configured");
    expect(err.message).toContain("could not sign a link");
    expect(h.calls).toHaveLength(0);
    h.cleanup();
  });

  test("now on an ended call offers a line that was filmed, not the one said just before the press", async () => {
    // Line 1 ends at 1:03 and Record was pressed at 1:04: the first filmed
    // line is 2, and line 1's own snap would be refused.
    const recs = recordings({}, [{ ...recordings().recordings[0], started_at: T + s(64) }]);
    const h = harness(recs);
    const err = await refusal(snapCall("cl-42", {}, h.deps));
    expect(err.details.try).toEqual(["cast call snap cl-42@1:04", "cast call snap cl-42:2"]);
    for (const cmd of err.details.try!) {
      const res = await snapCall(cmd.replace("cast call snap ", ""), {}, h.deps);
      expect(res.frames).toHaveLength(1);
    }
    expect(firstFilmedLine(callVideoSpans(recs), segments)?.seq).toBe(2);
    expect(firstFilmedLine([], segments)).toBeNull();
    h.cleanup();
  });

  test("now on an ended call: no video says so first; with video, the suggestions are moments that work", async () => {
    const none = harness(recordings({}, []));
    expect((await refusal(snapCall("cl-42", {}, none.deps))).code).toBe("not_recorded");
    none.cleanup();
    const h = harness(recordings({}, [{ ...recordings().recordings[0], started_at: T + s(61) }]));
    const err = await refusal(snapCall("cl-42", {}, h.deps));
    expect(err.code).toBe("not_live");
    expect(err.message).toContain("cast call snap cl-42@1:01, or a transcript line: cast call snap cl-42:1");
    h.cleanup();
  });

  test("a moment still being recorded: the live picture when it is now, with how long ago the line was", async () => {
    const live = recordings({ call_ended_at: null, server_now: T + s(139) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: "https://r2/c1.jpeg" },
    ]);
    const h = harness(live);
    const res = await snapCall("cl-42:2", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ live: true, at_ms: s(139) });
    expect(res.notes.join(" ")).toContain("Line 2 was 8s ago; this is the live picture now.");
    expect(formatSnapResult(res)).toContain("A live picture is not kept");
    const later = recordings({ call_ended_at: null, server_now: T + min(9) }, live.recordings);
    const err = await refusal(snapCall("cl-42:2", {}, harness(later).deps));
    expect(err.code).toBe("not_ready");
    expect(err.message).toContain("only when Record is stopped or the huddle ends");
    h.cleanup();
  });

  test("lookup, server and upload failures come back as refusals with codes, so --json stays JSON", async () => {
    const h = harness(recordings());
    const ambiguous = { ...h.deps, resolveCallId: async () => { throw Object.assign(new Error("matches 2 recent calls"), { code: "ambiguous" }); } };
    expect((await refusal(snapCall("k57:2", {}, ambiguous))).code).toBe("ambiguous");
    const down = { ...h.deps, post: async () => { throw new Error("Unauthorized"); } };
    const err = await refusal(snapCall("cl-42:2", {}, down));
    expect([err.code, err.message]).toEqual(["server", "Unauthorized"]);
    const badUpload = { ...h.deps, share: async () => { throw new Error("quota"); } };
    const res = await snapCall("cl-42:2", { share: true }, badUpload);
    expect(res.frames[0].image).toBeUndefined();
    expect(res.frames[0].image_error).toBe("quota");
    expect(res.notes.join(" ")).toContain("Could not upload cl-42_2m11s_screen.png: quota");
    h.cleanup();
  });

  test("--max on one moment is ignored, and said so; a colon time gets the @ form", async () => {
    const h = harness(recordings());
    expect((await snapCall("cl-42:2", { max: 3 }, h.deps)).notes.join(" ")).toContain("--max counts frames across a line range");
    const typo = await refusal(snapCall("cl-42:1:02:03", {}, h.deps));
    expect(typo.message).toContain("For a time, write cl-42@1:02:03");
    h.cleanup();
  });

  test("refusals carry their recovery as data, from the same values as the sentence", async () => {
    const h = harness(recordings());
    const outside = await refusal(snapCall("cl-42@8:00", {}, h.deps));
    expect(outside.details.nearest).toBe("cl-42@5:48");
    // The nearest filmed line beside it, for an agent stepping by line.
    expect(outside.details.nearest_line).toBe("cl-42:4");
    expect(outside.details.try).toEqual(["cast call snap cl-42@5:48", "cast call snap cl-42:4"]);
    expect(outside.message).toContain("Nearest: cast call snap cl-42@5:48. Nearest filmed line: cast call snap cl-42:4.");
    expect(outside.details.recorded?.map((r) => [r.kind, r.shows, r.from, r.to])).toEqual([
      ["composite", "the room", "0:50", "5:50"],
      ["screen", "Ana's screen", "2:00", "3:40"],
    ]);
    const strict = await refusal(snapCall("cl-42@1:00", { screen: true }, h.deps));
    // Every command the sentence names is in `try`: the nearest share, and
    // the same moment without --screen, since the room was filmed then.
    expect(strict.details).toMatchObject({
      nearest: "cl-42@2:00",
      nearest_line: "cl-42:2",
      try: ["cast call snap cl-42@2:00 --screen", "cast call snap cl-42:2 --screen", "cast call snap cl-42@1:00"],
    });
    h.cleanup();
  });

  test("now, just after Stop: the recording is saving, not missing", async () => {
    const saving = recordings({ call_ended_at: null, server_now: T + min(4) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "stopping", started_at: T + s(50), duration_ms: min(3), url: null, live_frame_url: null },
    ]);
    const h = harness(saving);
    const err = await refusal(snapCall("cl-42", {}, h.deps));
    expect(err.code).toBe("not_live");
    expect(err.message).toContain("cl-42's recording was just stopped and is saving; its moments can be snapped in a minute.");
    expect(err.details.recorded).toHaveLength(1);
    h.cleanup();
  });

  test("--screen across a share that ends mid-second keeps every frame on the share", async () => {
    // Ana's screen runs 1:40 to 3:20.5; a change 100.3 s into it would round
    // to 3:21, past her file's end, so it lands on 3:20 instead.
    const [room, screen] = recordings().recordings;
    const h = harness(recordings({}, [room, { ...screen, started_at: T + s(100), duration_ms: s(100.5) }]), ["frame:1 pts:1 pts_time:100.3", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:2-4", { screen: true }, h.deps);
    expect(res.frames.map((f) => [f.at, f.kind])).toEqual([["2:11", "screen"], ["3:20", "screen"]]);
    h.cleanup();
  });

  test("two shares at once: a change is grabbed from the file it was seen in", async () => {
    // Ana shares from 2:00, Bo from 2:10; the rule alone would pick Bo's
    // (the newer) for any moment both cover. Only Ana's screen changed.
    const [room, ana] = recordings().recordings;
    const bo = { ...ana, _id: "s2", started_at: T + s(130), participant_identity: "u_bo", participant_name: "Bo", url: "https://r2/s2.mp4" };
    const h = harness(recordings({}, [room, ana, bo]), (args) => ({
      code: 0,
      stderr: args.includes("https://r2/s1.mp4") ? ["frame:1 pts:1 pts_time:40", "lavfi.scene_score=0.9"].join("\n") : "",
    }));
    const res = await snapCall("cl-42:2-4", {}, h.deps);
    const change = res.frames.find((f) => f.at === "2:40")!;
    expect(change).toMatchObject({ kind: "screen", shows: "Ana's screen", recording_id: "s1" });
    h.cleanup();
  });

  test("the footer promises the cited picture only when it is this one, and never suggests a public upload", async () => {
    const h = harness(recordings());
    const screen = await snapCall("cl-42:2", {}, h.deps);
    expect(screen.frames[0]).toMatchObject({ citation_matches: true, citation_shows: "Ana's screen" });
    const text = formatSnapResult(screen);
    expect(text).toContain("on its own line in a message it renders as this picture for anyone who can read the call");
    expect(text).not.toContain("--share");
    const room = await snapCall("cl-42:2", { composite: true }, h.deps);
    expect(room.frames[0]).toMatchObject({ kind: "composite", citation_matches: false, citation_shows: "Ana's screen" });
    expect(formatSnapResult(room)).toContain("renders as Ana's screen at that moment, not the view shown here,");
    h.cleanup();
  });

  test("a public share link is refused with where to find the call's own reference", async () => {
    const h = harness(recordings());
    const err = await refusal(snapCall("https://codecast.sh/share/call/abc123", {}, h.deps));
    expect(err.code).toBe("bad_target");
    expect(err.message).toContain("is a public share link");
    expect(err.details.try).toEqual(["cast calls"]);
    h.cleanup();
  });
});

/** An object store answering ranges the way R2 does (`bytes=a-b`, the
 *  open-ended `bytes=a-`, or none), logging every request it sees. */
async function rangeStore(body: Buffer) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range ?? "";
    seen.push(range);
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) return void res.writeHead(200, { "content-length": String(body.length), "content-type": "video/mp4" }).end(body);
    const a = Number(m[1]);
    const b = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": String(b - a + 1), "accept-ranges": "bytes", "content-type": "video/mp4", etag: '"e1"' });
    res.end(body.subarray(a, b + 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { seen, url: `http://127.0.0.1:${(server.address() as any).port}/rec.mp4`, close: () => server.close() };
}

describe("signed links", () => {
  const recsAt = (url: string, now: number): SnapRecordings => ({
    ...recordings({ server_now: now }, [{ ...recordings().recordings[1], url, url_expires_at: now + min(10) }]),
  });

  test("renewed a minute before they lapse, measured on the server's clock", async () => {
    let clock = 1_000;
    let fetched = 0;
    // The server's clock is an hour ahead of ours; only the lifetime matters.
    const book = new SignedSources(recsAt("https://r2/a", T), async () => recsAt(`https://r2/b${++fetched}`, T + clock), () => clock);
    expect(await book.url("s1", false)).toBe("https://r2/a");
    clock += min(8.5);
    expect(await book.url("s1", false)).toBe("https://r2/a");
    clock += min(0.6);
    expect(await book.url("s1", false)).toBe("https://r2/b1");
    expect(await book.url("s1", false, true)).toBe("https://r2/b2");
  });

  test("the proxy forwards ranges, keeps the link off ffmpeg's command line, and signs again on a 403", async () => {
    const body = Buffer.from("0123456789abcdef");
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(`${req.url} ${req.headers.range ?? ""}`);
      if (req.url!.includes("old")) return void res.writeHead(403).end("expired");
      const [a, b] = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "")!.slice(1).map(Number);
      res.writeHead(206, { "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": String(b - a + 1), "accept-ranges": "bytes", "x-secret": "no" });
      res.end(body.subarray(a, b + 1));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(upstream.address() as any).port}`;
    let refetched = 0;
    const book = new SignedSources(recsAt(`${base}/old?sig=1`, T), async () => (refetched++, recsAt(`${base}/new?sig=2`, T)));
    const proxy = await serveSources(book);
    try {
      const url = proxy.urlFor("s1", false);
      expect(url).toStartWith("http://127.0.0.1:");
      expect(url).not.toContain("sig=");
      const res = await fetch(url, { headers: { range: "bytes=4-9" } });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 4-9/16");
      expect(res.headers.get("x-secret")).toBeNull();
      expect(await res.text()).toBe("456789");
      expect(refetched).toBe(1);
      expect(seen).toEqual(["/old?sig=1 bytes=4-9", "/new?sig=2 bytes=4-9"]);
      // Anything but a known file behind the random path is not served.
      expect((await fetch(url.replace(/\/[0-9a-f]{32}\//, "/guess/"))).status).toBe(404);
      expect((await fetch(proxy.urlFor("nope", false))).status).toBe(404);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  test("a file's tail is fetched once per command and answered from memory after", async () => {
    const body = Buffer.from("0123456789abcdefghij");
    const store = await rangeStore(body);
    const recs = recsAt(store.url, T);
    const live = { ...recs, recordings: recs.recordings.map((r) => ({ ...r, live_frame_url: store.url })) };
    const proxy = await serveSources(new SignedSources(live, async () => live));
    try {
      const url = proxy.urlFor("s1", false);
      for (let i = 0; i < 3; i++) {
        const res = await fetch(url, { headers: { range: "bytes=14-" } });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 14-19/20");
        expect(res.headers.get("content-length")).toBe("6");
        expect(res.headers.get("etag")).toBe('"e1"');
        expect(await res.text()).toBe("efghij");
      }
      expect(store.seen.filter((r) => r === "bytes=14-")).toHaveLength(1);
      // A bounded range and a different start are not the kept tail.
      expect(await (await fetch(url, { headers: { range: "bytes=2-4" } })).text()).toBe("234");
      expect(await (await fetch(url, { headers: { range: "bytes=16-" } })).text()).toBe("ghij");
      expect(store.seen).toEqual(["bytes=14-", "bytes=2-4", "bytes=16-"]);
      // A live frame is rewritten as the call goes on: always asked for.
      const liveUrl = proxy.urlFor("s1", true);
      await (await fetch(liveUrl, { headers: { range: "bytes=14-" } })).text();
      await (await fetch(liveUrl, { headers: { range: "bytes=14-" } })).text();
      expect(store.seen.filter((r) => r === "bytes=14-")).toHaveLength(3);
    } finally {
      await proxy.close();
      store.close();
    }
  });
});

// A real ffmpeg on a file like a screen share's: frames at 0 to 1.93 s, then
// none until 10 s. A plain seek to 5 s would return the frame at 10 s, from
// the future; the snap must return the one on screen at 5 s.
const realFfmpeg = findFfmpeg();
describe.skipIf(!realFfmpeg)("against a real ffmpeg", () => {
  test("every ffmpeg a snap starts reads the recording's index (written last, as LiveKit does) over the network once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-moov-"));
    const file = path.join(dir, "room.mp4");
    const run = ffmpegRunner(realFfmpeg!);
    // No +faststart: the moov follows the picture data, like an egress file.
    // Noise keeps the picture data past what one read takes in, so each
    // process has to jump to the end for the index.
    const made = await run(
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15:duration=6",
        "-vf", "noise=alls=60:allf=t", "-g", "15", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file],
      { timeoutMs: 60_000 },
    );
    expect(made.code).toBe(0);
    const bytes = fs.readFileSync(file);
    expect(bytes.indexOf("moov")).toBeGreaterThan(bytes.indexOf("mdat"));
    const store = await rangeStore(bytes);
    const [, screen] = recordings().recordings;
    const h = harness(recordings({}, [{ ...screen, duration_ms: s(6), url: store.url }]));
    let processes = 0;
    const counted: FfmpegRunner = (args, opts) => (processes++, run(args, opts));
    try {
      const res = await snapCall("cl-42@2:03", {}, { ...h.deps, ffmpeg: counted, serveSources });
      expect(res.frames[0].offset_ms).toBe(3000);
      expect(fs.statSync(res.frames[0].path).size).toBeGreaterThan(0);
      expect(processes).toBeGreaterThan(1);
      // The index's box starts 4 bytes before its name. ffmpeg's other
      // open-ended reads (the picture data from its start, and from the
      // frame's keyframe) are hung up on part way, so they are never kept.
      const moov = `bytes=${bytes.indexOf("moov") - 4}-`;
      expect(store.seen.filter((r) => r === moov)).toHaveLength(1);
    } finally {
      store.close();
      h.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a moment in a gap is the last picture before it, the one a <video> shows there", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-gap-"));
    const file = path.join(dir, "gap.mp4");
    const run = ffmpegRunner(realFfmpeg!);
    const made = await run(
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=12",
        "-vf", "select='lt(t,2)+gte(t,10)'", "-fps_mode", "passthrough", "-g", "15", "-c:v", "libx264", "-pix_fmt", "yuv420p", file],
      { timeoutMs: 60_000 },
    );
    expect(made.code).toBe(0);
    const [room, screen] = recordings().recordings;
    const recs = recordings({}, [room, { ...screen, duration_ms: s(12), url: file }]);
    const h = harness(recs);
    try {
      // Ana's file begins 2:00 into the call: 2:05 is 5 s in, inside the gap.
      const gap = await snapCall("cl-42@2:05", {}, { ...h.deps, ffmpeg: run });
      expect(gap.frames[0].kind).toBe("screen");
      expect(gap.frames[0].offset_ms).toBe(1933);
      expect(fs.statSync(gap.frames[0].path).size).toBeGreaterThan(0);
      expect(gap.notes.join(" ")).toContain("No new picture of Ana's screen was written after 2:01");
      // 10 s in, where the screen came back: the frame written at that moment.
      const after = await snapCall("cl-42@2:10", {}, { ...h.deps, ffmpeg: run });
      expect(after.frames[0].offset_ms).toBe(10_000);
    } finally {
      h.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("a stalled share: black filler is told from the picture, and the citation is not promised", async () => {
    // A picture for 2 s, then 4 s of solid black at the same frame rate, the
    // way LiveKit fills a paused share.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-stall-"));
    const file = path.join(dir, "stall.mp4");
    const run = ffmpegRunner(realFfmpeg!);
    const made = await run(
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=6",
        "-vf", "drawbox=enable='gte(t,2)':x=0:y=0:w=iw:h=ih:color=black:t=fill", "-g", "15", "-c:v", "libx264", "-pix_fmt", "yuv420p", file],
      { timeoutMs: 60_000 },
    );
    expect(made.code).toBe(0);
    const [room, screen] = recordings().recordings;
    const h = harness(recordings({}, [room, { ...screen, duration_ms: s(6), url: file }]));
    try {
      const res = await snapCall("cl-42@2:04", {}, { ...h.deps, ffmpeg: run });
      expect(res.frames[0].offset_ms).toBeLessThan(2000);
      expect(res.frames[0].citation_matches).toBe(false);
      expect(res.frames[0].notes[0]).toContain("was stalled at 2:04");
      // Before the stall, the picture at the moment, promised.
      const fine = await snapCall("cl-42@2:01", {}, { ...h.deps, ffmpeg: run });
      expect(fine.frames[0]).toMatchObject({ offset_ms: 1000, citation_matches: true, notes: [] });
    } finally {
      h.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("the spellings an agent arrives with", () => {
  test("bare seconds and the unit form the CLI prints read as times; the prose grammar stays strict", () => {
    expect(parseSnapTime("754")).toBe(s(754));
    expect(parseSnapTime("0")).toBe(0);
    expect(parseSnapTime("12m34s")).toBe(s(754));
    expect(parseSnapTime("4m05s")).toBe(s(245));
    expect(parseSnapTime("1h02m03s")).toBe(s(3723));
    expect(parseSnapTime("12m")).toBe(s(720));
    expect(parseSnapTime("1h")).toBe(min(60));
    expect(parseSnapTime("12:34")).toBe(s(754));
    for (const bad of ["", "soon", "12m75s", "1h75m", "s", "12.5m", "2:30.", ".5", "2:30.5555"]) expect(parseSnapTime(bad)).toBeNull();
    // A fraction of a second, in every spelling.
    expect(parseSnapTime("12.5")).toBe(12_500);
    expect(parseSnapTime("150.5s")).toBe(150_500);
    expect(parseSnapTime("2:30.5")).toBe(150_500);
    expect(parseSnapTime("2m30.25s")).toBe(150_250);
    expect(parseSnapTime("1:02:03.125")).toBe(3_723_125);
    const at = (ms: number) => ({ call: "cl-107", moment: { kind: "time" as const, atMs: ms } });
    expect(parseSnapTarget("cl-107@754")).toEqual(at(s(754)));
    expect(parseSnapTarget("cl-107@4m05s")).toEqual(at(s(245)));
    expect(parseSnapTarget("cl-107", "4m05s")).toEqual(at(s(245)));
    expect(parseSnapTarget("cl-107@0")).toEqual(at(0));
    // A bare number as a second word is still a line, as `cast call cl-42 15` reads it.
    expect(parseSnapTarget("cl-107", "15")).toEqual({ call: "cl-107", moment: { kind: "line", from: 15, to: 15 } });
  });

  test("a link's t is read in any time spelling, and one that is no time is refused, never taken for now", async () => {
    const id = "k57abcdefghijklmnopqrstuvwxyz012";
    expect(parseSnapTarget(`https://codecast.sh/calls/${id}?t=12:34`)).toEqual({ call: id, moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget(`https://codecast.sh/calls/${id}#t=754`)).toEqual({ call: id, moment: { kind: "time", atMs: s(754) } });
    expect(parseSnapTarget(`https://codecast.sh/calls/${id}?t=soon`)).toBeNull();
    const h = harness(recordings());
    const err = await refusal(snapCall("https://codecast.sh/calls/cl-42?t=soon", {}, h.deps));
    expect(err.code).toBe("bad_target");
    expect(err.message).toContain(`"soon" in that link is not a time into a call`);
    h.cleanup();
  });
});

describe("refusals name only commands they carry", () => {
  /** Every `cast ...` command a sentence names, up to the punctuation that
   *  ends it. */
  const named = (message: string) =>
    [...message.matchAll(/cast calls?(?: (?:snap|--[a-z]+|cl-\d+(?:[@:]\d+(?:[:-]\d+)*)?|\d+))*/g)].map((m) => m[0]);

  test("each refusal's try holds every command its sentence offers", async () => {
    const base = recordings();
    const [room, screen] = base.recordings;
    const live = recordings({ call_ended_at: null, server_now: T + min(3) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: "https://r2/c1.jpeg" },
      { _id: "s1", run_id: "r1", kind: "screen", status: "recording", started_at: T + s(120), participant_name: "Ana", url: null, live_frame_url: null },
    ]);
    const starting = recordings({ call_ended_at: null, server_now: T + min(3) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "starting", started_at: null, url: null, live_frame_url: null },
    ]);
    const endedSaving = recordings({}, [{ ...room, status: "stopping", url: null }]);
    const lateRoom = recordings({}, [{ ...room, started_at: T + s(100) }, screen]);
    const cases: Array<[SnapRecordings | null, string, Record<string, unknown>]> = [
      [base, "cl-42@1:00", { screen: true }],
      [recordings({}, [room]), "cl-42:1-2", { screen: true }],
      [recordings({}, [room]), "cl-42@1:00", { screen: true }],
      [base, "cl-42@8:00", {}],
      [base, "cl-42", {}],
      [base, "cl-42:9", {}],
      [recordings({}, []), "cl-42:2", {}],
      [live, "cl-42", { screen: true }],
      [live, "cl-42@1:30", {}],
      [starting, "cl-42", {}],
      [endedSaving, "cl-42", {}],
      [lateRoom, "cl-42:1", {}],
      [lateRoom, "cl-42:1", { screen: true }],
      [base, "cl-42:2:04", {}],
      [base, "cl-42:1:02:03", {}],
      [base, "https://codecast.sh/share/call/abc", {}],
      [null, "cl-42:2", {}],
    ];
    for (const [recs, target, opts] of cases) {
      const h = harness(recs);
      const err = await refusal(snapCall(target, opts, h.deps).then(() => {
        throw new Error(`${target} ${JSON.stringify(opts)} was not refused`);
      }));
      for (const cmd of named(err.message)) {
        expect({ target, code: err.code, cmd, try: err.details.try ?? [] }).toMatchObject({ try: expect.arrayContaining([cmd]) });
      }
      h.cleanup();
    }
  });

  test("a line outside the recording is refused in the line's own terms, with its words as the way back", async () => {
    const [room, screen] = recordings().recordings;
    const h = harness(recordings({}, [{ ...room, started_at: T + s(100) }, screen]));
    const err = await refusal(snapCall("cl-42:1", {}, h.deps));
    expect(err.code).toBe("outside");
    // Asked by line, so the nearest filmed line leads; the moment follows
    // with the warning that it is other words, and the line's own words end it.
    expect(err.message).toBe(
      "Line 1 was said at 1:00, before cl-42 was being recorded. Recorded: 1:40-6:40 the room, 2:00-3:40 Ana's screen. " +
        "Nearest filmed line: cast call snap cl-42:2. Nearest: cast call snap cl-42@1:40. That moment is not line 1: other words are being said there. Its own words: cast call cl-42 1.",
    );
    expect(err.details.try).toEqual(["cast call snap cl-42:2", "cast call snap cl-42@1:40", "cast call cl-42 1"]);
    const after = harness(recordings({}, [{ ...room, duration_ms: s(5) }]));
    expect((await refusal(snapCall("cl-42:2", {}, after.deps))).message).toStartWith("Line 2 was said at 2:10, after cl-42's recording had stopped.");
    after.cleanup();
    h.cleanup();
  });

  test("a short id typed without its prefix is offered back as the same snap on cl-N", async () => {
    const h = harness(recordings());
    const lookup = async () => {
      throw Object.assign(new Error(`No recent call matches "42"; did you mean cl-42? \`cast calls\` lists them`), { code: "not_found", try: ["cast call cl-42", "cast calls"] });
    };
    const err = await refusal(snapCall("42@2:11", {}, { ...h.deps, resolveCallId: lookup }));
    expect(err.code).toBe("not_found");
    expect(err.details.try).toEqual(["cast call snap cl-42@2:11", "cast calls"]);
    h.cleanup();
  });

  test("now on an ended call still saving: the same command again, and when", async () => {
    const [room] = recordings().recordings;
    const h = harness(recordings({}, [{ ...room, status: "stopping", url: null }]));
    const err = await refusal(snapCall("cl-42", { composite: true }, h.deps));
    expect(err.code).toBe("not_ready");
    expect(err.details).toMatchObject({ try: ["cast call snap cl-42 --composite"], retry_after_s: 60 });
    h.cleanup();
  });
});

describe("frames as data", () => {
  test("each frame says what it was asked to be, when its picture is from, and its own notes", async () => {
    const h = harness(recordings({}, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "ready", started_at: T + s(130), duration_ms: min(3), url: "https://r2/c1.mp4", live_frame_url: null },
      { _id: "s1", run_id: "r1", kind: "screen", status: "ready", started_at: T + s(120), duration_ms: s(100), participant_identity: "u_ana", participant_name: "Ana", url: "https://r2/s1.mp4", live_frame_url: null },
    ]));
    const res = await snapCall("cl-42@2:05", { composite: true }, h.deps);
    expect(res.frames[0]).toMatchObject({ kind: "screen", requested_kind: "composite", shown_at: "2:05", shown_at_ms: s(125) });
    expect(res.frames[0].notes).toEqual(["The room was not being recorded at 2:05, so this frame is the shared screen instead."]);
    const plain = await snapCall("cl-42@2:15", {}, h.deps);
    expect(plain.frames[0]).toMatchObject({ requested_kind: null, notes: [] });
    h.cleanup();
  });

  test("--composite while the room's video is still saving says so, not that the room was unfilmed", async () => {
    const h = harness(recordings({ call_ended_at: null, server_now: T + min(5) }, [
      { _id: "c1", run_id: "r1", kind: "composite", status: "recording", started_at: T + s(50), url: null, live_frame_url: "https://r2/c1.jpeg" },
      { _id: "s1", run_id: "r1", kind: "screen", status: "ready", started_at: T + s(120), duration_ms: s(100), participant_name: "Ana", url: "https://r2/s1.mp4", live_frame_url: null },
    ]));
    const res = await snapCall("cl-42@2:11", { composite: true }, h.deps);
    expect(res.frames[0].kind).toBe("screen");
    expect(res.notes).toEqual(["The room's video for 2:11 is still saving (it uploads when Record is stopped), so that frame is the shared screen for now."]);
    h.cleanup();
  });

  test("moments that land on one unchanged picture are one file and one note", async () => {
    // A scan that failed: evenly spaced moments, and the screen never changed
    // after 5 s into Ana's file.
    const h = harness(recordings(), () => ({ code: 1, stderr: "boom" }));
    const held: FfmpegRunner = async (args) => {
      if (args.includes("-skip_frame")) return { code: 1, stdout: "", stderr: "boom" };
      if (args.includes("-frames:v")) {
        fs.writeFileSync(args[args.length - 1], "png");
        return { code: 0, stdout: "", stderr: "[Parsed_showinfo_1] n:0 pts:5 pts_time:5.000" };
      }
      return { code: 0, stdout: "", stderr: "[Parsed_showinfo_5] n:0 pts:5 pts_time:5.000" };
    };
    const res = await snapCall("cl-42:2-4", { max: 4 }, { ...h.deps, ffmpeg: held });
    expect(res.frames).toHaveLength(1);
    expect(fs.readdirSync(h.dir)).toHaveLength(1);
    expect(res.notes.filter((n) => n.includes("No new picture"))).toEqual([]);
    expect(res.notes.join(" ")).toMatch(/Ana's screen did not change from 2:05 to \d:\d\d, so one frame stands for 4 of the moments across these lines\./);
    h.cleanup();
  });

  test("a change in a range's last partial second is grabbed at the change, and its citation is not promised", async () => {
    // Line 2 runs 130 s to 136 s, line 3 ends at 172 s: the range ends at
    // 172 s. A change 52.3 s into Ana's file (172.3 s) is past it; one at
    // 51.6 s (171.6 s) is inside the last partial second.
    const lines = recordings();
    const h = harness(lines, ["frame:1 pts:1 pts_time:51.6", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:2-3", {}, h.deps);
    const last = res.frames[res.frames.length - 1];
    expect(last.at_ms).toBe(171_600);
    expect(last.citation_matches).toBe(false);
    expect(last.notes.join(" ")).toContain("The screen changed just after 2:51");
    expect(formatSnapResult(res)).toContain("2:51, which may render as another picture");
    h.cleanup();
  });

  test("a range footer names the frames whose citation renders as something else", async () => {
    const h = harness(recordings(), ["frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7"].join("\n"));
    const res = await snapCall("cl-42:2-4", { composite: true, max: 3 }, h.deps);
    const text = formatSnapResult(res);
    for (const f of res.frames) expect(text).toContain(f.ref);
    expect(text).toContain("Cite any frame by its reference");
    expect(text).toMatch(/except .*which render as Ana's screen/);
    h.cleanup();
  });

  test("a stalled share: the last real picture, and a citation that is not promised to match", async () => {
    const h = harness(recordings());
    const stalled: FfmpegRunner = async (args) => {
      if (args.includes("-frames:v")) {
        fs.writeFileSync(args[args.length - 1], "png");
        return { code: 0, stdout: "", stderr: "[Parsed_showinfo_1] n:0 pts:9 pts_time:9.200" };
      }
      // Black filler at 10.9 s (seen by the first tap only), the real picture at 9.2 s.
      return { code: 0, stdout: "", stderr: "[Parsed_showinfo_2] n:0 pts:9 pts_time:9.200\n[Parsed_showinfo_5] n:0 pts:9 pts_time:9.200\n[Parsed_showinfo_2] n:1 pts:10 pts_time:10.900" };
    };
    const res = await snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: stalled });
    expect(res.frames[0]).toMatchObject({ offset_ms: 9200, citation_matches: false, shown_at: "2:09" });
    // 2:10 is a whole second after the picture (2:09.2) and before the
    // filler (2:10.9), in the same file: a citation that renders it.
    expect(res.frames[0].notes[0]).toBe("Ana's screen was stalled at 2:11 and the recording holds black there, so this frame is its last real picture, from 2:09; cite cl-42@2:10, which renders this picture.");
    expect(res.frames[0]).toMatchObject({ ref: "cl-42@2:11", cite_instead: "cl-42@2:10" });
    expect(probeTimes("[Parsed_showinfo_2] pts_time:1\n[Parsed_showinfo_5] pts_time:1")).toEqual({ real: [1000], all: [1000] });
    h.cleanup();
  });
});

describe("a read cut short", () => {
  test("ffmpeg exiting 0 with nothing written is run once more", async () => {
    const h = harness(recordings());
    let grabs = 0;
    const flaky: FfmpegRunner = async (args) => {
      if (args.includes("-frames:v")) {
        if (++grabs > 1) fs.writeFileSync(args[args.length - 1], "png");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "[Parsed_showinfo_5] pts_time:10.999" };
    };
    const res = await snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: flaky });
    expect(grabs).toBe(2);
    expect(fs.existsSync(res.frames[0].path)).toBe(true);

    const cut: FfmpegRunner = async (args) =>
      args.includes("-frames:v")
        ? { code: 0, stdout: "", stderr: "[http @ 0x1] Stream ends prematurely at 1024, should be 9999 http://127.0.0.1:5/x" }
        : { code: 0, stdout: "", stderr: "[Parsed_showinfo_5] pts_time:10.999" };
    const err = await refusal(snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: cut }));
    expect(err.code).toBe("ffmpeg_failed");
    expect(err.message).toBe("The read of the recording was cut short before the frame at 2:11 was written (ffmpeg: Stream ends prematurely at 1024, should be 9999 <recording>). The frame is there; run the command again.");
    h.cleanup();
  });

  test("network options ride HTTP sources only", () => {
    expect(frameArgs("http://127.0.0.1:1/x", 1000, "/o/f.png")).toContain("-reconnect");
    expect(probeArgs("http://127.0.0.1:1/x", 1000, 2000)).toContain("-reconnect");
    expect(sceneArgs("http://127.0.0.1:1/x", 0, 1000)).toContain("-reconnect");
    expect(frameArgs("/tmp/x.mp4", 1000, "/o/f.png")).not.toContain("-reconnect");
  });

  test("a failed re-sign is the reason given, not ffmpeg's 502", async () => {
    const h = harness(recordings());
    let signed = 0;
    // The proxy is faked, so the run signs again the way the proxy would on
    // a 403, and that second signing is refused.
    let resign: Promise<unknown> = Promise.resolve();
    const deps = {
      ...h.deps,
      post: async (route: string, body: any) => {
        if (route === "/cli/calls/recordings" && ++signed > 1) throw new Error("Not logged in");
        return h.deps.post(route, body);
      },
      serveSources: async (sources: SignedSources) => ({
        urlFor: (id: string, live: boolean) => {
          resign = sources.url(id, live, true).catch(() => {});
          return "http://127.0.0.1:1/x";
        },
        close: async () => {},
      }),
      ffmpeg: (async () => {
        await resign;
        return { code: 1, stdout: "", stderr: "Server returned 5XX Server Error reply" };
      }) as FfmpegRunner,
    };
    const err = await refusal(snapCall("cl-42:2", {}, deps));
    expect(err.code).toBe("server");
    expect(err.message).toBe("Could not sign the recording link again: Not logged in");
    h.cleanup();
  });
});

// ── Round 2: lines on video, links on the picture, part of a frame ───────

/** The harness, with grabs that report a frame size the way showinfo does,
 *  so a crop has something to measure. */
function sizedHarness(recs: SnapRecordings, width: number, height: number) {
  const h = harness(recs);
  const inner = h.deps.ffmpeg;
  const ffmpeg: FfmpegRunner = async (args, opts) => {
    const r = await inner(args, opts);
    const isGrab = args.includes("-frames:v") && !args.some((a) => a.startsWith("crop="));
    return isGrab ? { ...r, stderr: `${r.stderr}\n[Parsed_showinfo_0] n:0 s:${width}x${height} fmt:yuv420p` } : r;
  };
  return { ...h, deps: { ...h.deps, ffmpeg } };
}

describe("which lines were filmed", () => {
  const spans = callVideoSpans({ recordings: recordings().recordings, call_started_at: T, server_now: T + min(20) });

  test("a line is filmed when a span covers the moment its frame is taken", () => {
    // The room runs 0:50 to 5:50; line 1's frame (1:01) is in it.
    expect(lineFilmed(spans, segments[0])).toBe(true);
    expect(lineFilmed(spans, { t0: s(10), t1: s(12) })).toBe(false);
  });

  test("each span names its first and last filmed line, and the header leads with them", () => {
    // The room (0:50-5:50) holds lines 1-4; Ana's screen (2:00-3:40) lines 2-4.
    expect(spanLines(spans, segments)).toEqual([{ from: 1, to: 4 }, { from: 2, to: 4 }]);
    expect(describeSpansByLine(spans, segments)).toBe("lines 1-4 (0:50-5:50) the room, lines 2-4 (2:00-3:40) Ana's screen");
    // A span no line falls in reads as the clock alone.
    expect(describeSpansByLine(spans, [])).toBe(describeSpans(spans));
  });

  test("a snap is offered only where a finished file covers it", () => {
    expect(snapHint("cl-42", spans, { atMs: s(150) })).toBe("cast call snap cl-42@2:30");
    expect(snapHint("cl-42", spans, { atMs: s(150.5) })).toBe("cast call snap cl-42@2:30.5");
    expect(snapHint("cl-42", spans, { atMs: s(400) })).toBeNull();
    expect(snapHint("cl-42", [], { atMs: s(150) })).toBeNull();
    expect(snapHint("cl-42", spans, { from: 2, to: 3, fromMs: s(131), toMs: s(172) })).toBe("cast call snap cl-42:2-3");
    expect(snapHint("cl-42", spans, { from: 9, to: 9, fromMs: s(400), toMs: s(410) })).toBeNull();
    const saving = spans.map((x) => ({ ...x, pending: true }));
    expect(snapHint("cl-42", saving, { atMs: s(150) })).toBeNull();
  });

  test("where no snap is offered, the moment and line views say why in the same words", () => {
    // Past the room's end (5:50): the nearest recorded second, by moment and by lines.
    expect(noPictureNote("cl-42", spans, true, { fromMs: s(400), toMs: s(400), stretch: "moment", ref: "cl-42@6:40" })).toEqual({
      note: "Not recorded at that moment. Nearest recorded: ",
      command: "cast call snap cl-42@5:48",
      nearest: "cl-42@5:48",
    });
    expect(noPictureNote("cl-42", spans, true, { fromMs: s(400), toMs: s(410), stretch: "line", ref: "cl-42:9" })?.note).toBe(
      "Not recorded while that line was said. Nearest recorded: ",
    );
    // Before the room began (0:50): the nearest end of the lines decides.
    expect(noPictureNote("cl-42", spans, true, { fromMs: s(10), toMs: s(40), stretch: "lines", ref: "cl-42:1-2" })).toMatchObject({
      note: "Not recorded during these lines. Nearest recorded: ",
      nearest: "cl-42@0:50",
    });
    // Filmed but still saving: the same command, for when the file lands.
    const saving = spans.map((x) => ({ ...x, pending: true }));
    expect(noPictureNote("cl-42", saving, true, { fromMs: s(131), toMs: s(172), stretch: "lines", ref: "cl-42:2-3" })).toEqual({
      note: "These lines were recorded and are still saving. Once Record is stopped and the file lands: ",
      command: "cast call snap cl-42:2-3",
      nearest: null,
    });
    // No video at all, said only when the server answered.
    expect(noPictureNote("cl-42", [], true, { fromMs: s(10), toMs: s(10), stretch: "moment", ref: "cl-42@0:10" })?.note).toBe("This call has no video.");
    expect(noPictureNote("cl-42", [], false, { fromMs: s(10), toMs: s(10), stretch: "moment", ref: "cl-42@0:10" })).toBeNull();
  });
});

describe("moments between seconds", () => {
  test("a fraction of a second is read in every spelling, and kept exact", () => {
    expect(parseSnapTarget("cl-117@2:30.5")).toEqual({ call: "cl-117", moment: { kind: "time", atMs: 150_500 } });
    expect(parseSnapTarget("cl-117@150.5s")).toEqual({ call: "cl-117", moment: { kind: "time", atMs: 150_500 } });
    expect(parseSnapTarget("cl-117", "@2:30.25")).toEqual({ call: "cl-117", moment: { kind: "time", atMs: 150_250 } });
    expect(parseSnapTarget("https://codecast.sh/calls/k57call?t=150.5")).toEqual({ call: "k57call", moment: { kind: "time", atMs: 150_500 } });
    expect(snapMomentRef("cl-117", 150_500)).toBe("cl-117@2:30.5");
    expect(snapMomentRef("cl-117", 150_000)).toBe("cl-117@2:30");
  });

  test("the frame is named and printed to the millisecond; its citation names the whole second and says it may differ", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42@2:30.5", {}, h.deps);
    const f = res.frames[0];
    expect(f).toMatchObject({ ref: "cl-42@2:30", at: "2:30.5", at_ms: 150_500, citation_matches: false });
    expect(path.basename(f.path)).toBe("cl-42_2m30.5s_screen.png");
    expect(f.notes.join(" ")).toContain("between two seconds");
    h.cleanup();
  });
});

describe("a frame's link opens on its picture", () => {
  // Two shares cover 2:30: Ana's (from 2:00) and a guest's (from 1:50). The
  // latest start wins by default, so the guest's screen is what a link names.
  const two = () =>
    recordings({}, [
      ...recordings().recordings,
      { _id: "s2", run_id: "r1", kind: "screen", status: "ready", started_at: T + s(110), duration_ms: s(100), participant_identity: "guest:x", participant_name: "Kim (guest)", url: "https://r2/s2.mp4", live_frame_url: null },
    ]);

  test("a room frame's link names no view", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42@2:30", { composite: true }, h.deps);
    expect(res.frames[0].kind).toBe("composite");
    expect(res.frames[0].call_url).toBe("https://codecast.sh/calls/cl-42?t=150");
    h.cleanup();
  });

  test("a pasted link copied on someone's screen snaps that screen", async () => {
    expect(parseSnapTarget("https://codecast.sh/calls/k57call?t=150&view=screen:guest%3Ax")?.view).toEqual({ screen: true, identity: "guest:x" });
    const plain = harness(two());
    const byDefault = await snapCall("cl-42@2:30", {}, plain.deps);
    expect(byDefault.frames[0].recording_id).toBe("s1");
    plain.cleanup();
    const h = harness(two());
    const res = await snapCall("https://codecast.sh/calls/k57call?t=150&view=screen:guest%3Ax", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ recording_id: "s2", shows: "Kim's screen (guest)" });
    expect(res.frames[0].call_url).toBe("https://codecast.sh/calls/cl-42?t=150&view=screen:guest%3Ax");
    h.cleanup();
  });
});

describe("part of a frame", () => {
  test("--crop takes named parts and boxes in pixels or percent, and refuses anything else", () => {
    expect(parseCrop("top-left")).toEqual({ name: "top-left" });
    expect(parseCrop("TL")).toEqual({ name: "top-left" });
    expect(parseCrop(undefined)).toBeNull();
    expect(cropRect(parseCrop("top-left")!, 2880, 1800)).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
    expect(cropRect(parseCrop("right")!, 2880, 1800)).toEqual({ x: 1440, y: 0, w: 1440, h: 1800 });
    expect(cropRect(parseCrop("100,200,960,540")!, 2880, 1800)).toEqual({ x: 100, y: 200, w: 960, h: 540 });
    expect(cropRect(parseCrop("50%,50%,50%,25%")!, 2000, 1000)).toEqual({ x: 1000, y: 500, w: 1000, h: 250 });
    // Past an edge is cut back to the frame; wholly outside is nothing.
    expect(cropRect(parseCrop("2000,0,4000,100")!, 2880, 1800)).toEqual({ x: 2000, y: 0, w: 880, h: 100 });
    expect(cropRect(parseCrop("3000,0,100,100")!, 2880, 1800)).toBeNull();
    for (const bad of ["middle-ish", "1,2,3", "0,0,0,10", "0,0,150%,10"]) expect(() => parseCrop(bad)).toThrow(SnapError);
  });

  test("--tiles names quadrants, halves and finer grids, each at full resolution", () => {
    expect(parseTiles("2x2")).toEqual({ cols: 2, rows: 2 });
    for (const bad of ["1x1", "5x2", "2by2", ""]) expect(() => parseTiles(bad)).toThrow(SnapError);
    // Each tile reaches 6% of a tile past an inner edge (58 px across, 32
    // down here), so a line of text on a seam is whole in one of them.
    expect(tileRects(2, 2, 1921, 1080).map((t) => [t.suffix, t.rect])).toEqual([
      ["tl", { x: 0, y: 0, w: 1018, h: 572 }],
      ["tr", { x: 902, y: 0, w: 1019, h: 572 }],
      ["bl", { x: 0, y: 508, w: 1018, h: 572 }],
      ["br", { x: 902, y: 508, w: 1019, h: 572 }],
    ]);
    // Outer edges stay on the frame: the outermost tiles end at its sides.
    const grid = tileRects(3, 3, 3840, 2160);
    expect(Math.min(...grid.map((t) => t.rect.x))).toBe(0);
    expect(Math.max(...grid.map((t) => t.rect.x + t.rect.w))).toBe(3840);
    expect(Math.max(...grid.map((t) => t.rect.y + t.rect.h))).toBe(2160);
    expect(tileRects(2, 1, 100, 50).map((t) => t.suffix)).toEqual(["l", "r"]);
    expect(tileRects(1, 2, 100, 50).map((t) => t.suffix)).toEqual(["t", "b"]);
    expect(tileRects(3, 1, 90, 50).map((t) => t.suffix)).toEqual(["r1c1", "r1c2", "r1c3"]);
  });

  test("every frame carries its size, and a wide screen's output offers a crop", async () => {
    const h = sizedHarness(recordings(), 2880, 1800);
    const res = await snapCall("cl-42:2", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ width: 2880, height: 1800, crop: null });
    const out = formatSnapResult(res);
    expect(out).toContain("2880x1800");
    expect(out).toContain("Text small? cast call snap cl-42:2 --crop top-left");
    // One line per snap: the full --crop grammar is in --help and in the
    // refusal of a --crop it cannot read, not repeated under every frame.
    expect(out).not.toContain(CROP_FORMS);
    expect(() => parseCrop("upper-ish")).toThrow(`--crop takes ${CROP_FORMS}`);
    expect(out).not.toContain("No new picture");
    h.cleanup();
  });

  test("--crop cuts the frame once it is read, and --tiles writes each tile beside it", async () => {
    const h = sizedHarness(recordings(), 2880, 1800);
    const res = await snapCall("cl-42:2", { crop: "top-left", tiles: "2x2" }, h.deps);
    const f = res.frames[0];
    expect(f).toMatchObject({ width: 1440, height: 900, crop: { x: 0, y: 0, w: 1440, h: 900 } });
    expect(f.tiles!.map((t) => [path.basename(t.path), t.width, t.height])).toEqual([
      ["cl-42_2m11s_screen_top-left_tl.png", 763, 477],
      ["cl-42_2m11s_screen_top-left_tr.png", 763, 477],
      ["cl-42_2m11s_screen_top-left_bl.png", 763, 477],
      ["cl-42_2m11s_screen_top-left_br.png", 763, 477],
    ]);
    // The recording is read once; the crop and the tiles are cut from the
    // frame on disk.
    const cuts = h.calls.filter((a) => a.some((x) => x.startsWith("crop=")));
    expect(cuts.map((a) => a[a.indexOf("-vf") + 1])).toEqual(["crop=1440:900:0:0", "crop=763:477:0:0", "crop=763:477:677:0", "crop=763:477:0:423", "crop=763:477:677:423"]);
    expect(cuts.every((a) => a[a.indexOf("-i") + 1] === f.path)).toBe(true);
    expect(fs.existsSync(f.path)).toBe(true);
    // Asked for part of the picture: no hint to ask for it again.
    expect(formatSnapResult(res)).not.toContain("Text small?");
    h.cleanup();
  });

  test("a crop outside the frame is refused with the frame's size", async () => {
    const h = sizedHarness(recordings(), 1920, 1080);
    const err = await refusal(snapCall("cl-42:2", { crop: "4000,0,10,10" }, h.deps));
    expect(err.code).toBe("bad_option");
    expect(err.message).toContain("outside the 1920x1080 frame");
    h.cleanup();
  });
});

describe("words against the picture", () => {
  test("a short line spanning no whole second is framed after its first word and reported as itself", async () => {
    // cl-117's line 8 (2:41.501-2:41.808) was framed at 2:41, before it
    // began, and printed as line 7, the line being said then.
    const short = { seq: 3, speaker_name: "Bo", text: "Marker 8", t0: 150_501, t1: 150_808 };
    const theCall = { ...call, segments: [segments[0], segments[1], short, { ...segments[3], seq: 4 }] };
    const h = harness(recordings(), "", theCall);
    const res = await snapCall("cl-42:3", {}, h.deps);
    expect(res.frames[0].at_ms).toBe(s(151));
    expect(res.frames[0].line).toMatchObject({ ref: "cl-42:3", text: "Marker 8", during: false });
    expect(formatSnapResult(res)).toContain('Bo cl-42:3 "Marker 8" (said at 2:30, just before)');
    // A range from that line starts with it, not a second before.
    const range = await snapCall("cl-42:3-4", { max: 2 }, h.deps);
    expect(range.frames[0].at_ms).toBeGreaterThanOrEqual(short.t0);
    h.cleanup();
  });

  test("a line that ended a while before the frame says how long before", async () => {
    // 2:30 falls 14 s after line 2 ended (2:16); it began at 2:10.
    const h = harness(recordings());
    const res = await snapCall("cl-42@2:30", {}, h.deps);
    expect(res.frames[0].line).toMatchObject({ ref: "cl-42:2", during: false, at_ms: s(130), ended_ms: s(136) });
    // Measured from the end of its words, the last moment they and the
    // picture shared.
    expect(formatSnapResult(res)).toContain("(said 2:10-2:16, 14s before this frame)");
    h.cleanup();
  });

  test("a line that just ended is 'just before'", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42@2:17", {}, h.deps);
    expect(formatSnapResult(res)).toContain("(said 2:10-2:16, just before)");
    h.cleanup();
  });
});

// ── Round 7: spread, speed, stalls, silences, tiles ──────────────────────

describe("a range spread over its changes", () => {
  test("more cuts than frames: the frames cover the stretch, not its biggest cuts bunched together", () => {
    // A slide deck: 29 slides five seconds apart, each cut scoring a little
    // higher than the last. Biggest-first would take the last seven.
    const cuts = Array.from({ length: 29 }, (_, i) => ({ atMs: (i + 1) * 5000, score: 0.05 + i * 0.01 }));
    const picked = pickSceneMoments([{ atMs: 0, score: Infinity }, ...cuts], { max: 8 });
    expect(picked).toHaveLength(8);
    expect(picked[0]).toBe(0);
    const span = 145_000;
    const gaps = picked.slice(1).map((p, i) => p - picked[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual((2 * span) / 8);
  });

  test("the parts a span covers, the complement of uncoveredParts", () => {
    expect(coveredParts([{ fromMs: 10, toMs: 20 }, { fromMs: 15, toMs: 30 }, { fromMs: 50, toMs: 60 }], 0, 70)).toEqual([[10, 30], [50, 60]]);
    expect(coveredParts([{ fromMs: 0, toMs: 100 }], 10, 20)).toEqual([[10, 20]]);
    expect(coveredParts([], 0, 10)).toEqual([]);
  });
});

describe("a range read a few frames at a time", () => {
  test("grabs overlap up to GRAB_CONCURRENCY, a change the scene pass saw is read without a probe, and the order holds", async () => {
    const log = [
      "frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7",
      "frame:2 pts:2 pts_time:30", "lavfi.scene_score=0.01",
      "frame:3 pts:3 pts_time:55", "lavfi.scene_score=0.5",
    ].join("\n");
    const h = harness(recordings(), log);
    let inflight = 0;
    let peak = 0;
    const slow: FfmpegRunner = async (args, opts) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      try {
        return await h.deps.ffmpeg(args, opts);
      } finally {
        inflight--;
      }
    };
    const res = await snapCall("cl-42:2-4", {}, { ...h.deps, ffmpeg: slow });
    expect(res.frames.map((f) => f.at_ms)).toEqual([s(131), s(140), s(150), s(175)]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(GRAB_CONCURRENCY);
    // Four frames, one probe: only the range's first picture had to be found.
    const probes = h.calls.filter((a) => a.some((x) => x.startsWith("trim=end=")));
    expect(probes).toHaveLength(1);
    expect(h.grabs()).toHaveLength(4);
    // The change 20 s into Ana's file is read from two seconds before it,
    // and picked at the keyframe itself.
    const grab = h.grabs().find((a) => a.some((x) => x.startsWith("trim=start=19.999")))!;
    expect(grab[grab.indexOf("-ss") + 1]).toBe("18.000");
    expect(res.frames.map((f) => f.shown_at_ms)).toEqual([s(131), s(140), s(150), s(175)]);
    expect(res.frames.every((f) => f.citation_matches)).toBe(true);
    h.cleanup();
  });
});

describe("a stalled share with a citation that renders it", () => {
  // The room file runs from 0:50. The probe sees the last real picture at
  // 47.2 s into it and LiveKit's filler from 48.5 s.
  const stalledRunner: FfmpegRunner = async (args) => {
    if (args.includes("-frames:v")) {
      fs.writeFileSync(args[args.length - 1], "png");
      return { code: 0, stdout: "", stderr: "[Parsed_showinfo_1] n:0 pts:47 pts_time:47.200" };
    }
    return { code: 0, stdout: "", stderr: "[Parsed_showinfo_2] n:0 pts:47 pts_time:47.200\n[Parsed_showinfo_5] n:0 pts:47 pts_time:47.200\n[Parsed_showinfo_2] n:1 pts:48 pts_time:48.500" };
  };

  test("a range frame moves to the second that renders its picture", async () => {
    const h = harness(recordings({}, [recordings().recordings[0]]));
    // One frame across lines 1-2 lands at 1:39, 49 s into the room file.
    const res = await snapCall("cl-42:1-2", { max: 1 }, { ...h.deps, ffmpeg: stalledRunner });
    const f = res.frames[0];
    expect(f).toMatchObject({ ref: "cl-42@1:38", at: "1:38", at_ms: s(98), shown_at_ms: 97_200, citation_matches: true, call_url: "https://codecast.sh/calls/cl-42?t=98" });
    expect(f.cite_instead).toBeUndefined();
    expect(f.notes[0]).toBe("The room stalled at 1:38; this is its last picture before that, cl-42@1:38.");
    expect(path.basename(f.path)).toBe("cl-42_1m38s_composite.png");
    expect(fs.existsSync(f.path)).toBe(true);
    expect(formatSnapResult(res)).toContain("renders as this picture");
    h.cleanup();
  });

  test("a moment asked for keeps its name and offers the one that renders", async () => {
    const h = harness(recordings({}, [recordings().recordings[0]]));
    const res = await snapCall("cl-42@1:39", {}, { ...h.deps, ffmpeg: stalledRunner });
    expect(res.frames[0]).toMatchObject({ ref: "cl-42@1:39", citation_matches: false, cite_instead: "cl-42@1:38" });
    expect(res.frames[0].notes[0]).toContain("cite cl-42@1:38, which renders this picture.");
    h.cleanup();
  });
});

describe("a frame in a silence", () => {
  test("it is placed between the lines either side", async () => {
    // Line 2 ends at 2:16 and line 3 begins at 2:50: at 2:40 nothing has
    // been said for longer than a line is held.
    const h = harness(recordings());
    const res = await snapCall("cl-42@2:40", {}, h.deps);
    const f = res.frames[0];
    expect(f.line).toBeNull();
    expect(f.between).toEqual({ before: { ref: "cl-42:2", at: "2:10" }, after: { ref: "cl-42:3", at: "2:50" } });
    expect(formatSnapResult(res)).toContain("(nothing said; between cl-42:2 at 2:10 and cl-42:3 at 2:50)");
    // With a line, no placing.
    expect((await snapCall("cl-42:2", {}, h.deps)).frames[0].between).toBeNull();
    h.cleanup();
  });

  test("the lines either side of a moment, by one search", () => {
    expect(linesAround(segments, s(160))).toEqual({ before: segments[1], after: segments[2] });
    expect(linesAround(segments, s(10))).toEqual({ before: null, after: segments[0] });
    expect(linesAround(segments, s(900))).toEqual({ before: segments[3], after: null });
    expect(linesAround(undefined, 0)).toEqual({ before: null, after: null });
  });

  test("when a line was said, against a moment minutes later, in the words a frame uses", () => {
    expect(saidBefore({ t0: s(148), t1: s(148) }, s(540), "this moment")).toBe("said at 2:28, 6m32s before this moment");
    expect(saidBefore({ t0: s(130), t1: s(136) }, s(150), "this frame")).toBe("said 2:10-2:16, 14s before this frame");
    expect(saidBefore({ t0: s(130), t1: s(136) }, s(137), "this frame")).toBe("said 2:10-2:16, just before");
  });
});

describe("text on a wide frame", () => {
  test("the grid that keeps every tile at the frame's own pixels", () => {
    expect(readableTiles(1920, 1080)).toEqual({ cols: 2, rows: 1 });
    expect(readableTiles(2560, 1440)).toEqual({ cols: 2, rows: 2 });
    expect(readableTiles(2880, 1800)).toEqual({ cols: 3, rows: 2 });
    expect(readableTiles(3840, 2160)).toEqual({ cols: 3, rows: 3 });
    expect(readableTiles(1280, 720)).toBeNull();
  });

  test("a room frame offers the hint too, worded for the share inside it, once", async () => {
    const h = sizedHarness(recordings({}, [recordings().recordings[0]]), 1920, 1080);
    const res = await snapCall("cl-42:1-2", { max: 3 }, h.deps);
    expect(res.frames.every((f) => f.kind === "composite" && f.suggested_tiles === "2x1")).toBe(true);
    const out = formatSnapResult(res);
    expect(out).toContain("Text on a shared screen small? cast call snap cl-42:1-2 --tiles 2x1 for the whole frame in overlapping parts at full size, or --crop around the share.");
    expect(out.split("small?").length - 1).toBe(1);
    // A 4K screen is offered the finer grid.
    const big = sizedHarness(recordings(), 3840, 2160);
    const four = await snapCall("cl-42:2", {}, big.deps);
    expect(four.frames[0].suggested_tiles).toBe("3x3");
    expect(formatSnapResult(four)).toContain("Text small? cast call snap cl-42:2 --crop top-left, or --tiles 3x3");
    h.cleanup();
    big.cleanup();
  });
});

describe("cast call offers what was shown", () => {
  test("each filmed stretch's range snap, and a shared screen's first", () => {
    const spans = callVideoSpans({ recordings: recordings().recordings, call_started_at: T, server_now: T + min(20) });
    // The room's entry says --composite: a bare snap of those lines prefers
    // the share that overlaps it, and the reader picking the room wants faces.
    expect(spanSnaps("cl-42", spans, segments)).toEqual(["cast call snap cl-42:1-4 --composite", "cast call snap cl-42:2-4"]);
    // With no share over it, the room's snap needs no flag.
    const roomOnly = callVideoSpans({ recordings: [recordings().recordings[0]], call_started_at: T, server_now: T + min(20) });
    expect(spanSnaps("cl-42", roomOnly, segments)).toEqual(["cast call snap cl-42:1-4"]);
    expect(bestSpanSnap("cl-42", spans, segments)).toBe("cast call snap cl-42:2-4");
    // A stretch with one line is offered as that line, not as a range.
    expect(bestSpanSnap("cl-42", spans, segments.slice(0, 1))).toBeNull();
  });

  test("lines span from the first line's frame to the last line's own frame", () => {
    // A short last line takes its frame after its words end; the range that
    // names it reaches that frame.
    expect(linesSpan([{ ...segments[1], t0: s(135), t1: s(140) }, { ...segments[2], t0: 161_501, t1: 161_808 }])).toEqual({ fromMs: s(136), toMs: s(162) });
    // The end never precedes the start.
    expect(linesSpan([{ ...segments[0], t0: 60_100, t1: 60_000 }])).toEqual({ fromMs: s(61), toMs: s(61) });
  });

  test("a line said in a file's last second is not offered, and its note points off it", () => {
    // The room ends at 5:50. This line starts inside its last second, but its
    // frame (the next whole second) is after the file.
    const spans = callVideoSpans({ recordings: [recordings().recordings[0]], call_started_at: T, server_now: T + min(20) });
    const edge = [{ seq: 5, speaker_name: "Bo", text: "Thanks all.", t0: 349_400, t1: 349_900 }];
    const span = linesSpan(edge);
    expect(snapHint("cl-42", spans, { from: 5, to: 5, ...span })).toBeNull();
    // Measured from the same frame snapHint used, the nearest is off the
    // file's last keyframe, not 5:49 (the clock the transcript prints for the
    // line itself).
    expect(noPictureNote("cl-42", spans, true, { ...span, stretch: "line", ref: "cl-42:5" })?.nearest).toBe("cl-42@5:48");
  });

  test("--screen refusals for a call nobody shared in: the room when it answers, else the nearest filmed room line", async () => {
    // Filmed 3:00-3:30 only: line 4 is on video, line 3 is not.
    const late = harness(recordings({}, [{ _id: "c1", run_id: "r1", kind: "composite", status: "ready", started_at: T + s(180), duration_ms: s(30), url: "https://r2/c1.mp4", live_frame_url: null }]));
    const off = await refusal(snapCall("cl-42:3", { screen: true }, late.deps));
    expect(off.code).toBe("no_screen");
    expect(off.message).toBe(
      "Nobody shared a screen while cl-42 was recorded. Nearest filmed line: cast call snap cl-42:4. Nearest: cast call snap cl-42@3:00. That moment is not line 3: other words are being said there. Its own words: cast call cl-42 3.",
    );
    expect(off.details.try).toEqual(["cast call snap cl-42:4", "cast call snap cl-42@3:00", "cast call cl-42 3"]);
    late.cleanup();
    const room = harness(recordings({}, [recordings().recordings[0]]));
    const on = await refusal(snapCall("cl-42:2", { screen: true }, room.deps));
    expect(on.message).toBe("Nobody shared a screen while cl-42 was recorded. For the room, drop --screen: cast call snap cl-42:2. Its own words: cast call cl-42 2.");
    expect(on.details.try).toEqual(["cast call snap cl-42:2", "cast call cl-42 2"]);
    room.cleanup();
  });

  test("the nearest refusal steps off a file's last second, onto a moment and a line that both answer", async () => {
    const h = harness(recordings());
    const err = await refusal(snapCall("cl-42@9:00", {}, h.deps));
    // The room ends at 5:50: two seconds inside it, and line 4, the last filmed.
    expect(err.details).toMatchObject({ nearest: "cl-42@5:48", nearest_line: "cl-42:4" });
    h.cleanup();
  });
});
