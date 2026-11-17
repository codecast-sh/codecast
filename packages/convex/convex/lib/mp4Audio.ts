// The sound of a video, as an audio-only m4a, without decoding anything.
//
// A phone screen recording is tens to hundreds of MB, the transcription
// endpoint refuses anything over 25 MB, and a Convex action has no ffmpeg. But
// the audio in an MP4 or a QuickTime MOV (what iOS writes) is already AAC in
// its own track, and its samples sit in the file as byte runs ("chunks") the
// sample tables point at. So the audio file can be assembled by copying: read
// the `moov` box (the tables), read only the audio chunks, and write a new file
// whose one track is the original audio track, its chunk offsets rewritten to
// point into a new `mdat`. Nothing is decoded or re-encoded, the bytes read
// are the sound plus the tables, and each read is a Range request, so a 200 MB
// video costs a few MB of transfer and memory.
//
// Covered: MP4 and MOV with a regular (non-fragmented) `moov`, wherever it
// sits, 32 or 64 bit chunk offsets. A fragmented file (`mvex`) or a compressed
// movie header (`cmov`) is refused by name; neither is what a phone or a
// browser's recorder writes.

/** Somewhere bytes can be read from at an offset: a file, a buffer, a URL. */
export type ByteSource = {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type ExtractedAudio = {
  /** The m4a: ftyp, moov with one audio track, mdat. */
  bytes: Uint8Array;
  /** The audio track's length, from its media header. */
  durationMs: number;
};

export class Mp4AudioError extends Error {
  constructor(
    readonly reason: "not_mp4" | "fragmented" | "compressed_header" | "no_moov" | "too_large" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

type Box = { type: string; start: number; headerSize: number; size: number };

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** The child boxes of `b[from, to)`. */
function boxesIn(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < headerSize || o + size > to) break;
    out.push({ type, start: o, headerSize, size });
    o += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string) =>
  boxesIn(b, parent.start + parent.headerSize, parent.start + parent.size).find((x) => x.type === type) ?? null;

function path(b: Uint8Array, root: Box, types: string[]): Box | null {
  let cur: Box | null = root;
  for (const t of types) {
    if (!cur) return null;
    cur = child(b, cur, t);
  }
  return cur;
}

/** Bounds on what an uploaded file may claim. Every number below comes from
 *  bytes the uploader chose, so each one is checked before it is used. */
/** Top-level boxes walked before giving up: a real file has a handful. */
const MAX_TOP_BOXES = 4096;
/** The movie header read into memory: an hour of 60 fps video's tables are a
 *  few MB. */
export const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const malformed = (what: string) => new Mp4AudioError("malformed", `malformed file: ${what}`);

/** How many fixed-size entries a full box's table can hold after `skip`
 *  bytes of its payload: what a count it declares must not exceed. */
function tableRoom(box: Box, skip: number, entryBytes: number): number {
  return Math.max(0, Math.floor((box.size - box.headerSize - 4 - skip) / entryBytes));
}

/** The top-level boxes of the whole source, read header by header. */
async function topLevel(src: ByteSource): Promise<Box[]> {
  const out: Box[] = [];
  let o = 0;
  while (o + 8 <= src.size) {
    if (out.length >= MAX_TOP_BOXES) throw malformed("too many top-level boxes");
    const h = await src.read(o, Math.min(16, src.size - o));
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    let headerSize = 8;
    if (size === 1) {
      size = u64(h, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = src.size - o;
    }
    if (size < headerSize) break;
    out.push({ type, start: o, headerSize, size });
    o += size;
  }
  return out;
}

/** The full box (header included), from the bytes of its parent. */
const slice = (b: Uint8Array, box: Box) => b.subarray(box.start, box.start + box.size);

/** Full-box payload start: after the header and the version/flags word. */
const fullPayload = (box: Box) => box.start + box.headerSize + 4;

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function boxBytes(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Reads closer than this are fetched as one: a recorder interleaves audio
 *  and video in runs well under a second long, so every audio chunk sits a
 *  few hundred KB of video from the next, and one read per chunk would be
 *  hundreds of round trips for a minute of recording. */
const COALESCE_GAP = 256 * 1024;
/** Upper bound on one read, so a coalesced run never balloons. */
const MAX_READ = 8 * 1024 * 1024;
/** Reads in flight at once. */
const READ_CONCURRENCY = 6;

/**
 * The audio track of an MP4 or MOV as an m4a, or null when the file has no
 * audio track (a screen recording made with the microphone off).
 *
 * `maxBytes` bounds the output: a recording whose sound alone is larger than
 * that is refused before any of it is read.
 */
export async function extractAudioTrack(src: ByteSource, opts: { maxBytes?: number } = {}): Promise<ExtractedAudio | null> {
  const top = await topLevel(src);
  if (!top.some((b) => b.type === "ftyp" || b.type === "moov" || b.type === "mdat" || b.type === "wide")) {
    throw new Mp4AudioError("not_mp4", "not an MP4 or QuickTime file");
  }
  const moovBox = top.find((b) => b.type === "moov");
  if (!moovBox) throw new Mp4AudioError("no_moov", "the file has no movie header (was it cut off mid-upload?)");
  if (moovBox.size > MAX_MOOV_BYTES) throw malformed(`movie header of ${moovBox.size} bytes`);
  if (moovBox.start + moovBox.size > src.size) throw malformed("movie header runs past the end of the file");
  const moov = await src.read(moovBox.start, moovBox.size);
  const root: Box = { ...moovBox, start: 0 };
  if (child(moov, root, "cmov")) throw new Mp4AudioError("compressed_header", "compressed movie headers are not supported");
  if (child(moov, root, "mvex")) throw new Mp4AudioError("fragmented", "fragmented MP4 is not supported");
  const mvhd = child(moov, root, "mvhd");
  if (!mvhd) throw new Mp4AudioError("no_moov", "the movie header has no mvhd");

  const traks = boxesIn(moov, root.headerSize, root.size).filter((b) => b.type === "trak");
  const audio = traks.find((t) => {
    const hdlr = path(moov, t, ["mdia", "hdlr"]);
    return hdlr && fourcc(moov, fullPayload(hdlr) + 4) === "soun";
  });
  if (!audio) return null;

  const mdhd = path(moov, audio, ["mdia", "mdhd"])!;
  const mdhdVersion = moov[mdhd.start + mdhd.headerSize];
  const timescale = mdhdVersion === 1 ? u32(moov, fullPayload(mdhd) + 16) : u32(moov, fullPayload(mdhd) + 8);
  const duration = mdhdVersion === 1 ? u64(moov, fullPayload(mdhd) + 20) : u32(moov, fullPayload(mdhd) + 12);

  const stbl = path(moov, audio, ["mdia", "minf", "stbl"]);
  if (!stbl) throw new Mp4AudioError("not_mp4", "the audio track has no sample table");
  const stsc = child(moov, stbl, "stsc");
  const stsz = child(moov, stbl, "stsz");
  const stco = child(moov, stbl, "stco") ?? child(moov, stbl, "co64");
  if (!stsc || !stsz || !stco) throw new Mp4AudioError("not_mp4", "the audio track's sample table is incomplete");
  const wide = stco.type === "co64";

  // Chunk offsets, as the source has them. Each declared count is held to
  // what its own box can carry.
  const chunkCount = u32(moov, fullPayload(stco));
  if (chunkCount > tableRoom(stco, 4, wide ? 8 : 4)) throw malformed("chunk table longer than its box");
  const offsets: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const at = fullPayload(stco) + 4 + i * (wide ? 8 : 4);
    offsets.push(wide ? u64(moov, at) : u32(moov, at));
  }

  // Sample sizes: one size for all, or a table.
  const constantSize = u32(moov, fullPayload(stsz));
  const sampleCount = u32(moov, fullPayload(stsz) + 4);
  if (!constantSize && sampleCount > tableRoom(stsz, 8, 4)) throw malformed("sample size table longer than its box");
  const sizeOf = (i: number) => (constantSize ? constantSize : u32(moov, fullPayload(stsz) + 8 + i * 4));

  // Samples per chunk, from stsc's runs.
  const runs: Array<{ first: number; perChunk: number }> = [];
  const stscCount = u32(moov, fullPayload(stsc));
  if (stscCount > tableRoom(stsc, 4, 12)) throw malformed("chunk run table longer than its box");
  for (let i = 0; i < stscCount; i++) {
    const at = fullPayload(stsc) + 4 + i * 12;
    runs.push({ first: u32(moov, at), perChunk: u32(moov, at + 4) });
  }
  // One pass over the runs (sorted by first chunk, as the format requires),
  // bounded by the samples there are, not by what a run claims per chunk.
  const lengths: number[] = [];
  let sample = 0;
  let run = -1;
  for (let c = 0; c < chunkCount; c++) {
    const chunkNo = c + 1;
    while (run + 1 < runs.length && runs[run + 1].first <= chunkNo) run++;
    const perChunk = run >= 0 ? runs[run].perChunk : 0;
    let len = 0;
    for (let k = 0; k < perChunk && sample < sampleCount; k++, sample++) len += sizeOf(sample);
    if (len > 0 && (offsets[c] < 0 || offsets[c] + len > src.size)) throw malformed("a chunk lies outside the file");
    lengths.push(len);
  }
  const total = lengths.reduce((n, l) => n + l, 0);
  if (opts.maxBytes && total > opts.maxBytes) {
    throw new Mp4AudioError("too_large", `the sound alone is ${Math.round(total / 1024 / 1024)} MB, over the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`);
  }

  // The new file: ftyp, then a moov holding mvhd and the audio trak (stco
  // patched in place, so no box changes size), then the chunks back to back.
  const ftyp = boxBytes("ftyp", ascii("M4A "), new Uint8Array(4), ascii("M4A "), ascii("mp42"), ascii("isom"));
  const trak = slice(moov, audio).slice();
  const newMoov = boxBytes("moov", slice(moov, mvhd), trak);
  const mdatHeader = 8;
  const dataStart = ftyp.length + newMoov.length + mdatHeader;
  // Where the trak sits inside newMoov, and its stco inside the trak.
  const trakAt = 8 + mvhd.size;
  const stcoInTrak = stco.start - audio.start;
  let cursor = dataStart;
  for (let i = 0; i < chunkCount; i++) {
    const at = trakAt + stcoInTrak + (stco.headerSize + 4) + 4 + i * (wide ? 8 : 4);
    const dv = new DataView(newMoov.buffer, newMoov.byteOffset);
    if (wide) {
      dv.setUint32(at, Math.floor(cursor / 2 ** 32));
      dv.setUint32(at + 4, cursor >>> 0);
    } else {
      dv.setUint32(at, cursor);
    }
    cursor += lengths[i];
  }

  const data = new Uint8Array(total);
  // Plan reads in source order, coalescing near chunks.
  const order = offsets.map((o, i) => ({ o, i })).filter((x) => lengths[x.i] > 0).sort((a, b) => a.o - b.o);
  const dest: number[] = [];
  let acc = 0;
  for (let i = 0; i < chunkCount; i++) {
    dest.push(acc);
    acc += lengths[i];
  }
  type Read = { from: number; to: number; chunks: number[] };
  const reads: Read[] = [];
  for (const { o, i } of order) {
    const last = reads[reads.length - 1];
    const end = o + lengths[i];
    if (last && o - last.to <= COALESCE_GAP && end - last.from <= MAX_READ) {
      last.to = Math.max(last.to, end);
      last.chunks.push(i);
    } else {
      reads.push({ from: o, to: end, chunks: [i] });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < reads.length) {
      const r = reads[next++];
      const bytes = await src.read(r.from, r.to - r.from);
      for (const i of r.chunks) data.set(bytes.subarray(offsets[i] - r.from, offsets[i] - r.from + lengths[i]), dest[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, reads.length) }, worker));

  const mdat = new Uint8Array(mdatHeader);
  new DataView(mdat.buffer).setUint32(0, mdatHeader + total);
  mdat.set(ascii("mdat"), 4);
  return {
    bytes: concat([ftyp, newMoov, mdat, data]),
    durationMs: timescale ? Math.round((duration / timescale) * 1000) : 0,
  };
}

/** A ByteSource over a URL that answers Range requests (a presigned R2 GET). */
export function urlByteSource(url: string, size: number, fetchFn: typeof fetch = fetch): ByteSource {
  return {
    size,
    async read(offset, length) {
      const res = await fetchFn(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`range read ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // A server that ignores Range answers 200 with the whole file.
      return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
    },
  };
}

/** A ByteSource over bytes in memory (tests, small files). */
export function bufferByteSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
}
