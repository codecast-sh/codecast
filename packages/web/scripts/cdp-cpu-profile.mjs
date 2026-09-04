const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const port = readArg("--port", "9222");
const targetMatch = readArg("--target", "codecast.sh");
const output = readArg("--output", "/tmp/codecast-cpu-profile.json");
const durationMs = Number(readArg("--duration-ms", "10000"));
const reload = args.includes("--reload");
const offline = args.includes("--offline");
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes(targetMatch));
if (!target?.webSocketDebuggerUrl) throw new Error(`No page matching ${targetMatch} on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Network.enable");
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 1000 });
await send("Page.bringToFront");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
if (offline) {
  await send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
}
await send("Profiler.start");
if (reload) {
  const loaded = new Promise((resolve) => {
    const onMessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method !== "Page.loadEventFired") return;
      socket.removeEventListener("message", onMessage);
      resolve();
    };
    socket.addEventListener("message", onMessage);
  });
  await send("Page.reload", { ignoreCache: false });
  await loaded;
}
await new Promise((resolve) => setTimeout(resolve, durationMs));
const { profile } = await send("Profiler.stop");
await Bun.write(output, JSON.stringify(profile));
if (offline) {
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
}
socket.close();

const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const totals = new Map();
for (let index = 0; index < profile.samples.length; index++) {
  const node = nodes.get(profile.samples[index]);
  if (!node) continue;
  const frame = node.callFrame;
  const key = `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}:${frame.functionName || "(anonymous)"}`;
  totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index] / 1000);
}
const top = [...totals]
  .map(([frame, selfMs]) => ({ frame, selfMs: Number(selfMs.toFixed(1)) }))
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 40);
console.log(JSON.stringify({ output, durationMs, samples: profile.samples.length, top }, null, 2));
