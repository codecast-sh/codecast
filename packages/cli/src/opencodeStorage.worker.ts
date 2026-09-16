// Worker thread for queryOpencodeDelta. The 1.5GB opencode.db mmap under swap
// pins the caller's event loop for seconds; running it here keeps heartbeats
// and message inject on the daemon loop.
import { queryOpencodeDelta } from "./opencodeStorageQuery.js";

type Request = { id: number; dbPath: string; watermark: number };

self.onmessage = (event: MessageEvent<Request>) => {
  const msg = event.data;
  try {
    const result = queryOpencodeDelta(msg.dbPath, msg.watermark);
    postMessage({ id: msg.id, ok: true, ...result });
  } catch (err) {
    postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
