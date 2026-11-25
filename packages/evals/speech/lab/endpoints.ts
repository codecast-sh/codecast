// The shipped endpointer (shared/contracts/asrEndpointer), run over a file so
// live.py's `vad=client` replay commits where the browser and phone would.
// stdin: 24 kHz PCM16 mono. stdout: JSON [[start_s, end_s, commit_at_byte], ...]
import { createEndpointer, ENDPOINTER_SAMPLE_RATE } from "../../../shared/contracts/asrEndpointer";

const buf = new Uint8Array(await Bun.stdin.arrayBuffer());
const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
const ep = createEndpointer();
const out: [number, number, number][] = [];
// The browser hands the pipe ~85 ms buffers; feed the same.
const CHUNK = 2_048;
for (let i = 0; i < pcm.length; i += CHUNK) {
  for (const ev of ep.push(pcm.subarray(i, i + CHUNK))) {
    if (ev.type === "end") out.push([ev.start / ENDPOINTER_SAMPLE_RATE, ev.end / ENDPOINTER_SAMPLE_RATE, ev.commitAt * 2]);
  }
}
// finish() commits what is still open.
const open = ep.turnStart;
if (open !== null) out.push([open / ENDPOINTER_SAMPLE_RATE, ep.position / ENDPOINTER_SAMPLE_RATE, pcm.length * 2]);
console.log(JSON.stringify(out));
