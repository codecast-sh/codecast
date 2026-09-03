const args = process.argv.slice(2);
const readArg = (name, index, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : args[index] && !args[index].startsWith("--") ? args[index] : fallback;
};
const port = readArg("--port", 0, "9222");
const targetMatch = readArg("--target", 1, "codecast.sh");
const output = readArg("--output", 2, "/tmp/codecast-trace.json");
const settleArg = readArg("--settle-ms", 3, "7000");
const settleMs = Number(settleArg);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page" && candidate.url.includes(targetMatch));
if (!target?.webSocketDebuggerUrl) throw new Error(`No page matching ${targetMatch} on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const listeners = new Map();
let nextId = 1;

socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  const waiting = listeners.get(message.method);
  if (!waiting?.length) return;
  listeners.delete(message.method);
  for (const resolve of waiting) resolve(message.params);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
console.error("connected");

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const once = (method) =>
  new Promise((resolve) => listeners.set(method, [...(listeners.get(method) ?? []), resolve]));

await send("Page.enable");
console.error("page enabled");
await send("Runtime.enable");
console.error("runtime enabled");
await send("Performance.enable");
console.error("performance enabled");
await send("Page.bringToFront");
console.error("front");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
console.error("focused");
await send("Tracing.start", {
  traceConfig: {
    recordMode: "recordContinuously",
    includedCategories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.screenshot",
      "blink.user_timing",
      "loading",
      "v8",
    ],
  },
  transferMode: "ReturnAsStream",
});
console.error("tracing");

const loaded = once("Page.loadEventFired");
await send("Page.reload", { ignoreCache: false });
await Promise.race([
  loaded,
  delay(30_000).then(() => {
    throw new Error("Timed out waiting for Page.loadEventFired");
  }),
]);
console.error("loaded");
await delay(settleMs);
console.error("settled");
const completed = once("Tracing.tracingComplete");
await send("Tracing.end");
const { stream } = await completed;
console.error("reading trace");
let trace = "";
for (;;) {
  const chunk = await send("IO.read", { handle: stream });
  trace += chunk.data;
  if (chunk.eof) break;
}
await send("IO.close", { handle: stream });
await Bun.write(output, trace);
const metrics = await send("Performance.getMetrics");
const page = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    url: location.href,
    visibility: document.visibilityState,
    navigation: performance.getEntriesByType("navigation")[0],
    paints: performance.getEntriesByType("paint"),
    resources: performance.getEntriesByType("resource").length,
    decodedBytes: performance.getEntriesByType("resource").reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
    scripts: performance.getEntriesByType("resource").filter((entry) => entry.initiatorType === "script").length,
    heap: performance.memory && performance.memory.usedJSHeapSize
  })`,
  returnByValue: true,
});
socket.close();

console.log(
  JSON.stringify({
    output,
    bytes: trace.length,
    page: JSON.parse(page.result.value),
    metrics: Object.fromEntries(metrics.metrics.map(({ name, value }) => [name, value])),
  }),
);
