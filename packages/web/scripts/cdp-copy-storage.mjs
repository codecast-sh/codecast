const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const port = readArg("--port", "9222");
const targetMatch = readArg("--target", "127.0.0.1");
const statePath = readArg("--state", "");
const sourceOrigin = readArg("--origin", "https://codecast.sh");
const navigate = readArg("--navigate", "");
if (!statePath) throw new Error("Missing --state <storage-state.json>");

const state = await Bun.file(statePath).json();
const source = state.origins?.find((origin) => origin.origin === sourceOrigin);
if (!source) throw new Error(`No storage state for ${sourceOrigin}`);
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

await send("Runtime.enable");
const values = Object.fromEntries(
  source.localStorage
    .filter(({ name }) => name.startsWith("__convexAuth") || name === "codecast-theme")
    .map(({ name, value }) => [name, value]),
);
await send("Runtime.evaluate", {
  expression: `Object.entries(${JSON.stringify(values)}).forEach(([key, value]) => localStorage.setItem(key, value))`,
});
if (navigate) await send("Page.navigate", { url: navigate });
socket.close();
console.log(JSON.stringify({ target: target.url, copied: Object.keys(values).length, navigate: navigate || undefined }));
