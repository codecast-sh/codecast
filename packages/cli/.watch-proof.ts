// Manual proof for ct-51658: the production watch server (attachWatchServer +
// cdpWatchEngine) on a throwaway loopback port, one viewer connected, every
// non-frame message printed. Deleted after the proof.
import * as http from "http";
import { WebSocket } from "ws";
import { attachWatchServer } from "./src/browser/watchServer.js";

const TOKEN = "proof-token-0123456789abcdef";
const sessionUuid = process.argv[2];
const runMs = Number(process.argv[3] ?? 90_000);
const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
attachWatchServer(server, { token: TOKEN, log: (m) => console.log("[server]", m) });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/watch/ws`, { headers: { Origin: "http://localhost:3200" } });
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, session_uuid: sessionUuid, fps: 2, protocol: 2 })));
let frames = 0;
const stamp = () => new Date().toISOString().slice(11, 23);
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "frame") { frames++; return; }
  console.log(stamp(), JSON.stringify(m).slice(0, 400));
});
ws.on("close", (c, r) => { console.log(stamp(), "closed", c, String(r), "frames received:", frames); process.exit(0); });
setTimeout(() => { console.log(stamp(), "done; frames received:", frames); ws.close(); }, runMs);
