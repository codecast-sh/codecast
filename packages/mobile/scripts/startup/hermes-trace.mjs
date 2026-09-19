// bun hermes-trace.mjs <ws-url> <seconds> <out.json>: record a Tracing session (RN Fusebox / Hermes sampling) and save the events
const [url, secs, out] = process.argv.slice(2);
const ws = new WebSocket(url); let id = 0; const pending = new Map(); const events = [];
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
let complete;
const done = new Promise((r) => { complete = r; });
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); return; }
  if (m.method === "Tracing.dataCollected") events.push(...(m.params?.value ?? []));
  if (m.method === "Tracing.tracingComplete") complete();
};
ws.onopen = async () => {
  try {
    const r = await call("Tracing.start", { categories: "-*,devtools.timeline,v8.execute,v8.cpu_profiler,v8.cpu_profiler.hires,disabled-by-default-v8.cpu_profiler,disabled-by-default-devtools.timeline", options: "sampling-frequency=1000", transferMode: "ReportEvents" });
    console.log("started", JSON.stringify(r));
  } catch (e) { console.log("start failed", JSON.stringify(e)); process.exit(1); }
  await new Promise((r) => setTimeout(r, Number(secs) * 1000));
  await call("Tracing.end").catch((e) => console.log("end failed", JSON.stringify(e)));
  await Promise.race([done, new Promise((r) => setTimeout(r, 60000))]);
  await Bun.write(out, JSON.stringify(events));
  const kinds = {}; for (const e of events) kinds[e.name] = (kinds[e.name] ?? 0) + 1;
  console.log("events", events.length, JSON.stringify(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  ws.close(); process.exit(0);
};
ws.onerror = (e) => { console.log("ws error", e?.message); process.exit(1); };
setTimeout(() => { console.log("timeout"); process.exit(2); }, (Number(secs) + 120) * 1000);
