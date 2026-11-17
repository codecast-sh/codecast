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

// Hand-built hostile files: an uploader controls every byte.
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = payload.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of payload) { out.set(p, o); o += p.length; }
  return out;
}
const u32s = (...n: number[]) => { const b = new Uint8Array(n.length * 4); const dv = new DataView(b.buffer); n.forEach((v, i) => dv.setUint32(i * 4, v >>> 0)); return b; };
const full = (type: string, ...payload: Uint8Array[]) => box(type, new Uint8Array(4), ...payload);
const hdlr = full("hdlr", u32s(0), new TextEncoder().encode("soun"), u32s(0, 0, 0), new Uint8Array(1));
const mdhd = full("mdhd", u32s(0, 0, 1000, 1000), u32s(0));
function audioMoov(stbl: Uint8Array[]): Uint8Array {
  return box("moov", full("mvhd", new Uint8Array(96)), box("trak", box("mdia", mdhd, hdlr, box("minf", box("stbl", ...stbl)))));
}
const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32s(0));
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const fast = async (bytes: Uint8Array) => {
  const t0 = performance.now();
  const err = await extractAudioTrack(bufferByteSource(bytes), { maxBytes: 25 * 1024 * 1024 }).then(() => null, (e) => e);
  return { err, ms: performance.now() - t0 };
};

describe("hostile files", () => {
  test("a chunk count far beyond its box is refused, not looped over", async () => {
    const moov = audioMoov([full("stsc", u32s(1, 1, 1, 1)), full("stsz", u32s(4, 1)), full("stco", u32s(0x7fffffff, 0))]);
    const { err, ms } = await fast(cat(ftyp, moov));
    expect(err).toBeInstanceOf(Mp4AudioError);
    expect(ms).toBeLessThan(200);
  });

  test("a sample table that claims more entries than it holds is refused", async () => {
    const moov = audioMoov([full("stsc", u32s(0x7fffffff, 1, 1, 1)), full("stsz", u32s(0, 0x7fffffff)), full("stco", u32s(1, 0))]);
    const { err, ms } = await fast(cat(ftyp, moov));
    expect(err).toBeInstanceOf(Mp4AudioError);
    expect(ms).toBeLessThan(200);
  });

  test("a movie header bigger than the cap, or than the file, is refused before it is read", async () => {
    let read = 0;
    const header = new Uint8Array(16);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 1); header.set(new TextEncoder().encode("moov"), 4); dv.setUint32(8, 0); dv.setUint32(12, 500 * 1024 * 1024);
    const src = { size: 600 * 1024 * 1024, read: async (o: number, l: number) => { read += l; return o === 0 ? header.subarray(0, l) : new Uint8Array(l); } };
    const err = await extractAudioTrack(src).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Mp4AudioError);
    expect(read).toBeLessThan(1024);
  });

  test("an endless run of tiny top-level boxes is cut off", async () => {
    const tiny = box("free");
    const many = new Uint8Array(tiny.length * 200_000);
    for (let i = 0; i < 200_000; i++) many.set(tiny, i * tiny.length);
    const { err, ms } = await fast(cat(ftyp, many));
    expect(err).toBeInstanceOf(Mp4AudioError);
    expect(ms).toBeLessThan(2000);
  });
});
