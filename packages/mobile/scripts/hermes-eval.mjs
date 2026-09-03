// Evaluate one expression in the running app over the Hermes inspector.
// Targets: curl -s http://localhost:<metro-port>/json (pick the "React Native Bridgeless" page).
// Dev-only auth: bun scripts/hermes-eval.mjs "<ws-url>" "__devAuth('<jwt>','<refresh>')" then reload.
// bun hermes-eval.mjs <ws-url> <expression> [timeoutMs]
const [url, expr, t] = process.argv.slice(2);
const timeout = Number(t || 15000);
const ws = new WebSocket(url);
const done = (msg, code = 0) => { console.log(msg); try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => done("TIMEOUT", 2), timeout);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) done(JSON.stringify(m.result ?? m.error)); };
ws.onerror = (e) => done("WS ERROR " + (e?.message || ""), 1);
