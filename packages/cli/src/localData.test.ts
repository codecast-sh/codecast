import { beforeEach, describe, expect, test } from "bun:test";
import { annotateLocalData, dataRoot, isDataPath, parseLsof, resetLocalDataForTest, summarizeOpenFiles, type OpenFile } from "./localData";
import type { ResourceProcess } from "@codecast/shared/contracts";

const HOME = "/Users/me";
const GB = 1024 ** 3;
const LIB = `${HOME}/Movies/iMovie Library.imovielibrary`;

describe("local data", () => {
  beforeEach(() => resetLocalDataForTest());

  test("lsof output keeps opened regular files and drops the executable, libraries, sockets and cwd", () => {
    const out = parseLsof([
      "p42", "fcwd", "tDIR", "s480", "n/Users/me/src/films",
      "ftxt", "tREG", "s1310208", "n/opt/homebrew/bin/ffmpeg",
      "f3", "tREG", `s${2 * GB}`, `n${LIB}/1-13-24/Original Media/clip.mov`,
      "f4", "tunix", "n->0x1",
      "p43", "f5", "tREG", "s10", "n/Users/me/src/films/out.mp4",
    ].join("\n"));
    expect(out).toEqual([
      { pid: 42, path: `${LIB}/1-13-24/Original Media/clip.mov`, size: 2 * GB },
      { pid: 43, path: "/Users/me/src/films/out.mp4", size: 10 },
    ]);
  });

  test("system, toolchain, cache and dependency files are not the session's data", () => {
    for (const p of ["/System/x", "/opt/homebrew/lib/a.dylib", "/private/var/folders/t/tmp.bin", `${HOME}/Library/Caches/x`, `${HOME}/.codecast/cache.db`, `${HOME}/src/app/node_modules/x/y.js`, `${HOME}/src/app/.git/objects/pack/p.pack`])
      expect(isDataPath(p, HOME)).toBe(false);
    for (const p of [`${LIB}/a.mov`, "/Volumes/Footage/b.mov", `${HOME}/data/train.parquet`])
      expect(isDataPath(p, HOME)).toBe(true);
  });

  test("a file is named by the library it sits in, else its directory", () => {
    expect(dataRoot(`${LIB}/1-13-24/Original Media/clip.mov`, HOME)).toBe("~/Movies/iMovie Library.imovielibrary");
    expect(dataRoot(`${HOME}/data/run-3/train.parquet`, HOME)).toBe("~/data/run-3");
  });

  test("a process holding gigabytes of footage reports it; one with small working files does not", () => {
    const files: OpenFile[] = [
      { pid: 1, path: `${LIB}/a/clip1.mov`, size: 3 * GB },
      { pid: 1, path: `${LIB}/b/clip2.mov`, size: 2 * GB },
      { pid: 1, path: `${LIB}/b/clip2.mov`, size: 2 * GB },
      { pid: 1, path: `${HOME}/src/films/edit.json`, size: 4000 },
      { pid: 2, path: `${HOME}/src/app/src/index.ts`, size: 9000 },
    ];
    const out = summarizeOpenFiles(files, HOME);
    expect(out.get(1)).toEqual({ bytes: 5 * GB + 4000, files: 3, root: "~/Movies/iMovie Library.imovielibrary" });
    expect(out.has(2)).toBe(false);
  });

  test("only busy session processes are read, at most once a minute, and a process keeps its finding between reads", async () => {
    const proc = (pid: number, cpu: number, sessionId?: string): ResourceProcess => ({ pid, ppid: 1, name: "p", kind: "tool", cpu, rss: 1, startedAt: 100, ...(sessionId ? { sessionId } : {}) });
    const reads: number[][] = [];
    const read = async (pids: number[]) => { reads.push(pids); return [{ pid: 7, path: "/Volumes/Footage/a.mov", size: 4 * GB }]; };
    const ps = [proc(7, 300, "s1"), proc(8, 1, "s1"), proc(9, 500)];
    const first = await annotateLocalData(ps, 1_000_000, read);
    expect(reads).toEqual([[7]]);
    expect(first.find((p) => p.pid === 7)?.localData).toEqual({ bytes: 4 * GB, files: 1, root: "/Volumes/Footage" });
    const again = await annotateLocalData(ps, 1_030_000, read);
    expect(reads).toHaveLength(1);
    expect(again.find((p) => p.pid === 7)?.localData?.bytes).toBe(4 * GB);
    await annotateLocalData(ps, 1_061_000, read);
    expect(reads).toHaveLength(2);
  });

  // Seen live: the finding vanished one tick after it appeared, because ps
  // moves a start time by a second between samples, and a read that did not
  // answer must not erase what an earlier one found.
  test("a finding survives start-time jitter and a read that did not answer", async () => {
    const proc = (startedAt: number): ResourceProcess => ({ pid: 7, ppid: 1, name: "ffmpeg", kind: "tool", cpu: 300, rss: 1, startedAt, sessionId: "s1" });
    await annotateLocalData([proc(100_000)], 1_000_000, async () => [{ pid: 7, path: "/Volumes/Footage/a.mov", size: 4 * GB }]);
    expect((await annotateLocalData([proc(99_457)], 1_030_000, async () => null))[0].localData?.bytes).toBe(4 * GB);
    expect((await annotateLocalData([proc(100_300)], 1_070_000, async () => null))[0].localData?.bytes).toBe(4 * GB);
    expect((await annotateLocalData([proc(100_000 + 120_000)], 1_080_000, async () => null))[0].localData).toBeUndefined();
  });
});
