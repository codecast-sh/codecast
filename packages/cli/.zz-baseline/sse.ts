/** One Server-Sent Events frame: its `event:` and `id:` fields and its joined `data:` lines. */
export interface SseFrame {
  event?: string;
  id?: string;
  data: string;
}

/**
 * Split a growing SSE buffer into complete frames. Frames are separated by a
 * blank line; within a frame every `data:` line is concatenated per the SSE
 * spec. Comments (`:`) and frames without data are skipped. Returns the frames
 * plus the unconsumed tail (a partial frame) to carry into the next chunk.
 */
export function parseSseStream(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  // Normalize CRLF so the frame delimiter is a single "\n\n".
  const normalized = buffer.replace(/\r\n/g, "\n");
  const lastBreak = normalized.lastIndexOf("\n\n");
  if (lastBreak === -1) return { frames, rest: normalized };

  for (const raw of normalized.slice(0, lastBreak).split("\n\n")) {
    const frame: SseFrame = { data: "" };
    const dataParts: string[] = [];
    for (const line of raw.split("\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const field = line.slice(0, colon);
      // A single leading space after the colon is part of the field syntax.
      const value = line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
      if (field === "data") dataParts.push(value);
      else if (field === "event") frame.event = value;
      else if (field === "id") frame.id = value;
    }
    if (dataParts.length === 0) continue;
    frame.data = dataParts.join("\n");
    frames.push(frame);
  }
  return { frames, rest: normalized.slice(lastBreak + 2) };
}

/** The frames of an SSE response body, as they arrive, until the stream ends. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseStream(buffer);
      buffer = rest;
      yield* frames;
    }
  } finally {
    // A caller that stops early (a `done` frame) releases the connection.
    reader.cancel().catch(() => {});
  }
}

/**
 * The frames of an SSE response body with their data parsed as JSON; a frame
 * that is not JSON is skipped. `endEvent`: a frame with that event ends the
 * stream (whatever its data).
 */
export async function* readSseJson<T>(body: ReadableStream<Uint8Array>, opts: { endEvent?: string } = {}): AsyncGenerator<{ event?: string; id?: string; data: T }> {
  for await (const frame of readSse(body)) {
    if (opts.endEvent !== undefined && frame.event === opts.endEvent) return;
    let data: T;
    try { data = JSON.parse(frame.data) as T; } catch { continue; }
    yield { ...(frame.event !== undefined ? { event: frame.event } : {}), ...(frame.id !== undefined ? { id: frame.id } : {}), data };
  }
}
