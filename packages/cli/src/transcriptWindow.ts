import fs from "node:fs";
import { isCursorRoleHeaderLine } from "./parser.js";
const SYNC_BYTES_PER_PASS = 1024 * 1024;

/**
 * Where a read window may be cut: the index of the LAST byte to consume, or
 * -1 to ask for a bigger window. `len` is how many bytes of `buf` are valid;
 * `atEof` says no more bytes exist past them; `from` is the first byte an
 * earlier step of the same window did not already search (bytes before it
 * hold no boundary, so a step costs only the tail it read).
 */
export type PassBoundary = (buf: Buffer, len: number, atEof: boolean, from?: number) => number;

// A newline is one byte and never part of a multibyte sequence, so a byte cut
// at it is charset safe and the byte count needs no re-encode.
const newlineBoundary: PassBoundary = (buf, len, _atEof, from = 0) => {
  const i = buf.subarray(from, len).lastIndexOf(0x0a);
  return i < 0 ? -1 : from + i;
};

type ReadRequest = { buf: Buffer; offset: number; length: number; position: number };

export type ReadWindowOpts = { step?: number; boundary?: PassBoundary; buffer?: Buffer; checkpoint?: () => void };

// The window algorithm both readers share: fill one window, look for a
// boundary, and when there is none and bytes remain, grow the window and
// read only the new tail. Growth doubles (capped at what exists) so an
// oversized line costs under twice its size in copying and a logarithmic
// number of steps; the boundary search covers only the new tail. Each
// `yield` is one read the driver performs (awaited or synchronous), so the
// async driver frees the loop between steps.
function* completeLinesPlan(
  position: number,
  available: number,
  opts: ReadWindowOpts,
  checkpoint?: () => void,
): Generator<ReadRequest, { content: string; bytesConsumed: number; steps: number }, number> {
  const step = opts.step ?? SYNC_BYTES_PER_PASS;
  const boundary = opts.boundary ?? newlineBoundary;
  checkpoint?.();
  // allocUnsafe: every byte read below `len` is written by a read first.
  let buf = opts.buffer ?? Buffer.allocUnsafe(Math.min(available, step));
  let len = 0;
  let steps = 0;
  for (;;) {
    checkpoint?.();
    const from = len;
    const want = Math.min(buf.length, available) - len;
    const n = want > 0 ? yield { buf, offset: len, length: want, position: position + len } : 0;
    checkpoint?.();
    steps++;
    if (n <= 0) available = len; // the file shrank under us: what we hold is all there is
    len += n;
    const atEof = len >= available;
    const cut = len > 0 ? boundary(buf, len, atEof, from) : -1;
    checkpoint?.();
    if (cut >= 0) {
      const content = buf.toString("utf8", 0, cut + 1);
      checkpoint?.();
      return { content, bytesConsumed: cut + 1, steps };
    }
    // No boundary at EOF: a line still being written. Consume nothing and let
    // the next pass re-read it (same rule as before the window existed).
    if (atEof) return { content: "", bytesConsumed: 0, steps };
    if (len < Math.min(buf.length, available)) continue;
    checkpoint?.();
    const grown = Buffer.allocUnsafe(Math.min(Math.max(buf.length * 2, step), available));
    buf.copy(grown, 0, 0, len);
    buf = grown;
  }
}

/**
 * The complete lines available at `position`, read one window at a time.
 * Replaces the old escape that, on a line longer than the window, re-read the
 * whole remaining file in one allocation; now an oversized line costs one
 * more window per step, with the loop free during every read.
 */
export async function readCompleteLines(
  fd: fs.promises.FileHandle,
  position: number,
  available: number,
  opts: ReadWindowOpts = {},
): Promise<{ content: string; bytesConsumed: number; steps: number }> {
  const checkpoint = opts.checkpoint;
  const plan = completeLinesPlan(position, available, opts, checkpoint);
  let r = plan.next(0);
  while (!r.done) {
    checkpoint?.();
    const { bytesRead } = await fd.read(r.value.buf, r.value.offset, r.value.length, r.value.position);
    checkpoint?.();
    r = plan.next(bytesRead);
  }
  checkpoint?.();
  return r.value;
}

/** The synchronous twin, for the hook paths that cannot await. */
export function readCompleteLinesSync(
  fd: number,
  position: number,
  available: number,
  opts: ReadWindowOpts = {},
): { content: string; bytesConsumed: number; steps: number } {
  const checkpoint = opts.checkpoint;
  const plan = completeLinesPlan(position, available, opts, checkpoint);
  let r = plan.next(0);
  while (!r.done) {
    checkpoint?.();
    const bytesRead = fs.readSync(fd, r.value.buf, r.value.offset, r.value.length, r.value.position);
    checkpoint?.();
    r = plan.next(bytesRead);
  }
  checkpoint?.();
  return r.value;
}

/**
 * One window of complete lines from `position`, on a handle held only for
 * the read. The read is async: a 1MB window still blocked the loop 8s when
 * the disk was contended (2026-09-02). The parse the caller does next stays
 * on the loop, which is what SYNC_BYTES_PER_PASS bounds.
 */
export async function readIngestWindow(
  filePath: string,
  position: number,
  available: number,
  opts?: { step?: number; boundary?: PassBoundary },
): Promise<{ content: string; bytesConsumed: number; steps: number }> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    return await readCompleteLines(fd, position, available, opts);
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * Cut a cursor transcript window just before its last role header, so a
 * message whose lines straddle the window is never synced truncated:
 * parseCursorTranscriptFile buffers lines until the next header, so a newline
 * cut inside a message would sync the first half and drop the rest. At EOF
 * the cut is the last newline, which is what a whole tail read did before.
 */
export const cursorPassBoundary: PassBoundary = (buf, len, atEof, from = 0) => {
  // At EOF the whole window is consumed, so this is the one full search.
  if (atEof) return newlineBoundary(buf, len, atEof, 0);
  const end = newlineBoundary(buf, len, atEof, from);
  if (end < 0) return -1; // the tail added no complete line, so no new header
  // Only a line the window holds whole can be a header: past the last
  // newline, "user:" may be the start of a content line still to come. The
  // header rule is the parser's own, so the cut and the parse agree. Lines
  // whole before `from` were judged by an earlier step, so decode from the
  // line that straddles it.
  const lineStart = from > 0 ? buf.lastIndexOf(0x0a, from - 1) + 1 : 0;
  const lines = buf.toString("utf8", lineStart, end).split("\n");
  let headerAt = -1;
  let bytes = lineStart;
  for (const l of lines) {
    if (bytes > 0 && isCursorRoleHeaderLine(l)) headerAt = bytes;
    bytes += Buffer.byteLength(l, "utf8") + 1;
  }
  // The byte before the header line is the newline that ends the previous one.
  return headerAt < 0 ? -1 : headerAt - 1;
};


const CODEX_META_HEAD_CHUNK = 256 * 1024;
const CODEX_META_HEAD_MAX = 16 * 1024 * 1024;
export function sessionMetaHeadCut(acc: string): number {
  let cut = 0;
  let nl = acc.indexOf("\n");
  while (nl >= 0) {
    const line = acc.slice(cut, nl);
    if (line.trim() && !line.includes('"type":"session_meta"')) return cut;
    cut = nl + 1;
    nl = acc.indexOf("\n", cut);
  }
  return -1;
}
export async function readCodexSessionMetaHeadAsync(filePath: string): Promise<string> {
  const size = (await fs.promises.stat(filePath)).size;
  const limit = Math.min(size, CODEX_META_HEAD_MAX);
  let acc = "";
  let offset = 0;
  while (offset < limit) {
    const { content, bytesConsumed } = await readIngestWindow(filePath, offset, limit - offset, { step: CODEX_META_HEAD_CHUNK });
    if (bytesConsumed === 0) break;
    acc += content;
    offset += bytesConsumed;
    const cut = sessionMetaHeadCut(acc);
    if (cut >= 0) return acc.slice(0, cut);
  }
  return acc;
}
