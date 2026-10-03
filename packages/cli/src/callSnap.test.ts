import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import {
  callVideoSpans,
  clockForName,
  describeSpans,
  firstRecordedWithin,
  frameArgs,
  frameFileName,
  ffmpegFailure,
  formatSnapResult,
  lineAt,
  lineFrameMs,
  nearestRecordedMs,
  outputPaths,
  parseSceneScores,
  parseSnapTarget,
  pickSceneMoments,
  sceneArgs,
  lastFrameArgs,
  lastShownMs,
  TAIL_READ_MS,
  serveSources,
  SignedSources,
  snapCall,
  SnapError,
  uncoveredParts,
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
  test("a line's frame is a whole second just inside it", () => {
    expect(lineFrameMs({ t0: 70_000, t1: 74_000 })).toBe(71_000);
    expect(lineFrameMs({ t0: 70_100, t1: 74_000 })).toBe(71_000);
    expect(lineFrameMs({ t0: 70_800, t1: 74_000 })).toBe(72_000);
    // Too short to reach the nudged second: the whole second it still spans,
    // so the citation (whole seconds) names the frame taken.
    expect(lineFrameMs({ t0: 70_800, t1: 71_200 })).toBe(71_000);
    expect(lineFrameMs({ t0: 70_900, t1: 71_200 })).toBe(71_000);
    // A line shorter than a second that spans no whole second: its own second.
    expect(lineFrameMs({ t0: 70_100, t1: 70_400 })).toBe(70_000);
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

function harness(recs: SnapRecordings | null, sceneLog: string | ((args: string[]) => { code: number | null; stderr: string }) = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-run-"));
  const calls: string[][] = [];
  const ffmpeg: FfmpegRunner = async (args) => {
    calls.push(args);
    if (args.includes("-copyts")) {
      const r = typeof sceneLog === "function" ? sceneLog(args) : { code: 0, stderr: sceneLog };
      return { stdout: "", ...r };
    }
    fs.writeFileSync(args[args.length - 1], "png");
    return { code: 0, stdout: "", stderr: "" };
  };
  const posts: Array<[string, any]> = [];
  const progress: string[] = [];
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
  return { dir, calls, posts, progress, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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

  test("a range over a share: frames where the screen changed, bounded by --max", async () => {
    // The share file's own clock: changes at 20s and 55s into it, a flicker at 30s.
    const log = [
      "frame:1 pts:1 pts_time:20", "lavfi.scene_score=0.7",
      "frame:2 pts:2 pts_time:30", "lavfi.scene_score=0.01",
      "frame:3 pts:3 pts_time:55", "lavfi.scene_score=0.5",
    ].join("\n");
    const h = harness(recordings(), log);
    const res = await snapCall("cl-42:2-4", {}, h.deps);
    expect(res.range).toBe("scene");
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
    expect(h.calls.some((a) => a.includes("-copyts"))).toBe(false);
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
    expect(strict.message).toBe("A shared screen in cl-42 is being recorded, and its own picture can be read once the recording is saved. For the call as it is now, with the share in it, drop --screen.");
    h.cleanup();
  });

  test("--share uploads and carries the markdown; the public image's alt names the moment, not the call's title", async () => {
    const h = harness(recordings());
    const res = await snapCall("cl-42:2", { share: true }, h.deps);
    expect(res.frames[0].image?.markdown).toBe("![cl-42@2:11, Ana's screen](https://img/cl-42_2m11s_screen.png)");
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

  test("a moment past a file's last written picture takes that picture and says from when", async () => {
    // LiveKit's duration is how long the egress ran; a share that stopped
    // changing wrote nothing after its last change (cl-107, 2026-10-02: a
    // 25.5 s run held 14.7 s of picture). Line 2's frame is 11 s into the
    // share's file; the file's last frame is at 6.5 s.
    const h = harness(recordings());
    const seen: string[][] = [];
    const sparse: FfmpegRunner = async (args) => {
      seen.push(args);
      if (!args.includes("-sseof")) return { code: 0, stdout: "", stderr: "" };
      fs.writeFileSync(args[args.length - 1], "png");
      return { code: 0, stdout: "", stderr: "[Parsed_showinfo_0] n:0 pts:5 pts_time:5.000\n[Parsed_showinfo_0] n:1 pts:6 pts_time:6.500\n" };
    };
    const res = await snapCall("cl-42:2", {}, { ...h.deps, ffmpeg: sparse });
    expect(seen).toHaveLength(3);
    expect(res.frames[0]).toMatchObject({ at_ms: s(131), offset_ms: 6500 });
    expect(res.notes).toContain("No new picture of Ana's screen was written after 2:06, so the frame for 2:11 is the last one, from 2:06.");
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

  test("last picture: a tail read on the file's own clock, the last logged time wins", () => {
    const args = lastFrameArgs("https://bucket/s.mp4", "/o/f.png");
    expect(args.indexOf("-sseof")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-sseof") + 1]).toBe(`-${(TAIL_READ_MS / 1000).toFixed(3)}`);
    expect(args).toContain("-copyts");
    expect(args.slice(-2)).toEqual(["-y", "/o/f.png"]);
    expect(lastShownMs("pts_time:14.328\nx pts_time:14.461333 y")).toBe(14461);
    expect(lastShownMs("no frames")).toBeNull();
  });

  test("the moment as a second word, the way an agent types it after `cast call cl-42 15:25`", async () => {
    const h = harness(recordings());
    expect((await snapCall("cl-42", {}, h.deps, "2")).frames[0].ref).toBe("cl-42@2:11");
    expect((await snapCall("cl-42", {}, h.deps, "@2:11")).frames[0]).toMatchObject({ ref: "cl-42@2:11", kind: "screen" });
    const pair = await snapCall("cl-42", { max: 2 }, h.deps, "2:04");
    expect(pair.target).toBe("cl-42:2-4");
    expect(pair.notes.join(" ")).toContain("For the time 2:04, write cl-42@2:04");
    h.cleanup();
  });

  test("a line that began just before the press is shown from its first recorded second", async () => {
    // Line 1 runs 1:00 to 1:03; the room's file starts 1.4s into it.
    const late = recordings({}, [{ ...recordings().recordings[0], started_at: T + s(61.4) }]);
    const h = harness(late);
    const res = await snapCall("cl-42:1", {}, h.deps);
    expect(res.frames[0]).toMatchObject({ at_ms: s(62), ref: "cl-42@1:02", offset_ms: 600 });
    expect(res.notes.join(" ")).toContain("Line 1 began at 1:00, before it was being recorded; this frame is from 1:02, 2s into it.");
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
    expect(even.notes).toEqual(["Nothing was recorded 1:01-1:50, so the frames come from the rest of these lines."]);
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
    expect(huge.calls.some((a) => a.includes("-copyts"))).toBe(false);
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
    const badUpload = { ...h.deps, upload: async () => { throw new Error("quota"); } };
    const res = await snapCall("cl-42:2", { share: true }, badUpload);
    expect(res.frames[0].image).toBeUndefined();
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
});

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
});
