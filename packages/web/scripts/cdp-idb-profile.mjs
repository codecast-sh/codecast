const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const port = readArg("--port", "9333");
const targetMatch = readArg("--target", "codecast.sh");
const tables = readArg("--tables", "").split(",").filter(Boolean);
const metaKeys = readArg("--meta-keys", "").split(",").filter(Boolean);
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

const expression = `(${async ({ requestedTables, requestedMetaKeys }) => {
  const request = indexedDB.open("codecast-store");
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = (name) => new Promise((resolve, reject) => {
    const start = performance.now();
    const tx = db.transaction(name, "readonly");
    const get = tx.objectStore(name).getAll();
    get.onsuccess = () => {
      const rows = get.result;
      let bytes = 0;
      for (const row of rows) bytes += JSON.stringify(row).length;
      resolve({ name, rows: rows.length, bytes, ms: performance.now() - start });
    };
    get.onerror = () => reject(get.error);
  });
  const readMeta = (keys) => new Promise((resolve, reject) => {
    const start = performance.now();
    const tx = db.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const requests = keys.map((key) => new Promise((done, fail) => {
      const get = store.get(key);
      get.onsuccess = () => done(get.result);
      get.onerror = () => fail(get.error);
    }));
    Promise.all(requests).then((rows) => {
      resolve({
        name: "meta",
        rows: rows.filter(Boolean).length,
        bytes: rows.reduce((sum, row) => sum + (row ? JSON.stringify(row).length : 0), 0),
        ms: performance.now() - start,
      });
    }, reject);
  });
  const names = requestedTables.length
    ? requestedTables.filter((name) => db.objectStoreNames.contains(name))
    : [...db.objectStoreNames];
  const sequential = [];
  for (const name of names) {
    if (name === "meta" && requestedMetaKeys.length) sequential.push(await readMeta(requestedMetaKeys));
    else sequential.push(await read(name));
  }
  const start = performance.now();
  await Promise.all(names.map((name) =>
    name === "meta" && requestedMetaKeys.length ? readMeta(requestedMetaKeys) : read(name)
  ));
  const parallelMs = performance.now() - start;
  db.close();
  return { names, metaKeys: requestedMetaKeys, sequential, parallelMs };
}})(${JSON.stringify({ requestedTables: tables, requestedMetaKeys: metaKeys })})`;
const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
socket.close();
if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
console.log(JSON.stringify(result.result.value, null, 2));
