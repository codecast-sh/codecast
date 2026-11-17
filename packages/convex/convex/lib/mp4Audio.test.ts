import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bufferByteSource, extractAudioTrack, Mp4AudioError, type ByteSource } from "./mp4Audio";

// The files are made here with ffmpeg (a synthetic picture and a tone), so
// nothing binary is committed; without ffmpeg the suite is skipped.
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp4audio-"));

function make(name: string, args: string[]): string {
  const out = path.join(dir, name);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, out]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return out;
}

function probe(file: string): { streams: Array<{ codec_type: string; codec_name: string }>; format: { duration: string } } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  return JSON.parse(String(r.stdout));
}

/** Decodes the whole file: a broken offset fails here even when probing passes. */
function decodes(file: string): boolean {
  const r = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
  return r.status === 0 && String(r.stderr).trim() === "";
}

/** Counts reads, to show the extractor does not read the video. */
function counted(bytes: Uint8Array): ByteSource & { readBytes: number } {
  const src = bufferByteSource(bytes);
  const out = { size: src.size, readBytes: 0, read: async (o: number, l: number) => { out.readBytes += l; return src.read(o, l); } };
  return out;
}

describe.skipIf(!ffmpeg)("extractAudioTrack", () => {
  const source = ffmpeg
    ? make("end.mp4", [
        "-f", "lavfi", "-i", "testsrc=size=390x844:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
      ])
    : "";

  for (const [name, args] of [
    ["moov at the end (mp4)", null],
    ["moov first (faststart)", ["-c", "copy", "-movflags", "+faststart"]],
    ["QuickTime mov", ["-c", "copy"]],
  ] as const) {
    test(name, async () => {
      const file = args ? make(name.replace(/\W+/g, "_") + (name.includes("mov") ? ".mov" : ".mp4"), ["-i", source, ...args]) : source;
      const src = counted(new Uint8Array(fs.readFileSync(file)));
      const out = await extractAudioTrack(src);
      expect(out).not.toBeNull();
      const m4a = path.join(dir, `${name.replace(/\W+/g, "_")}.m4a`);
      fs.writeFileSync(m4a, out!.bytes);
      const p = probe(m4a);
      expect(p.streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual(["audio:aac"]);
      expect(Math.abs(Number(p.format.duration) - 6)).toBeLessThan(0.2);
      expect(Math.abs(out!.durationMs - 6000)).toBeLessThan(200);
      expect(decodes(m4a)).toBe(true);
      // The video is most of the file and is never fetched in full.
      expect(src.readBytes).toBeLessThan(src.size);
    });
  }

  test("no audio track is null", async () => {
    const file = make("silent.mp4", ["-i", source, "-c", "copy", "-an"]);
    expect(await extractAudioTrack(bufferByteSource(new Uint8Array(fs.readFileSync(file))))).toBeNull();
  });

  test("sound over the limit is refused before reading it", async () => {
    await expect(extractAudioTrack(bufferByteSource(new Uint8Array(fs.readFileSync(source))), { maxBytes: 1000 })).rejects.toBeInstanceOf(Mp4AudioError);
  });

  test("a file that is not an MP4 is refused", async () => {
    await expect(extractAudioTrack(bufferByteSource(new TextEncoder().encode("hello world, not a movie")))).rejects.toBeInstanceOf(Mp4AudioError);
  });
});
