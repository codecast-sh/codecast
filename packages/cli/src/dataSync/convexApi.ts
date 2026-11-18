// The data sync engine's server: convex/dataSync.ts over HTTP, with this
// machine's token. Bytes go to Convex storage through an upload URL and come
// back through the URL each row names.

import { ConvexHttpClient } from "convex/browser";
import type { DataSyncApi } from "./engine.js";

const TIMEOUT_MS = 60_000;

export function convexDataSyncApi(o: { convexUrl: string; apiToken: string; deviceId?: string }): DataSyncApi {
  const client = new ConvexHttpClient(o.convexUrl);
  const auth = { api_token: o.apiToken };
  // skipQueue: the client otherwise runs every mutation through one serial queue (syncService.timeout.test.ts).
  const mutate = (name: string, args: Record<string, unknown>) => (client as any).mutation(name, { ...auth, ...args }, { skipQueue: true });
  const query = (name: string, args: Record<string, unknown>) => (client as any).query(name, { ...auth, ...args });
  return {
    async declareFolders(folders) { await mutate("dataSync:declareFolders", { folders }); },
    folders: () => query("dataSync:folders", {}),
    changes: (since) => query("dataSync:changes", { since }),
    knownContents: (shas) => (shas.length ? query("dataSync:knownContents", { shas }) : Promise.resolve([])),
    commit: (changes) => mutate("dataSync:commit", { device_id: o.deviceId, changes }),
    async upload(bytes) {
      const url: string = await mutate("dataSync:uploadUrl", {});
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
      return ((await res.json()) as { storageId: string }).storageId;
    },
    async download(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
