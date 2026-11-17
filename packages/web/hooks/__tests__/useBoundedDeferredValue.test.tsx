import { test, expect } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true });
(globalThis as any).window = dom.window; (globalThis as any).document = dom.window.document;
(globalThis as any).setImmediate = undefined;
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { useDeferredValue, useState, memo } = React;
const { useBoundedDeferredValue } = await import("../useBoundedDeferredValue");
let bounded = false;

const burn = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms); };
let micro = 0; let sibling = false; function Sib() { React.useSyncExternalStore(sub, () => (sibling ? snap : 0)); return null; } let rows=0, ticks=0, paneRenders=0;
const Row = ({ id }: { id: string }) => { rows++; burn(2); if (micro && rows % micro === 0) queueMicrotask(() => { ticks++; tick(); }); return <i>{id}</i>; };
const Body = memo(function Body({ id }: { id: string }) {
  return <div data-body={id}>{Array.from({ length: 150 }, (_, i) => <Row key={id + i} id={id} />)}</div>;
});
let setId: any; let snap = 0; const subs = new Set<() => void>(); const sub = (f: () => void) => { subs.add(f); return () => subs.delete(f); }; const tick = () => { snap++; subs.forEach((f) => f()); };
function Pane({ live }: { live: string }) {
  if (!sibling) React.useSyncExternalStore(sub, () => snap); else React.useSyncExternalStore(sub, () => 0);   // stands in for a store subscription of the streaming session
  paneRenders++; const id = bounded ? useBoundedDeferredValue(live, 500) : useDeferredValue(live);
  return <Body id={id} />;
}
function App() { const [id, s] = useState("A"); setId = s; return <><b data-live={id} /><Pane live={id} /><Sib /></>; }

async function run(tickEveryMs: number | null, waitMs: number, m = 0) {
  micro = m;
  const el = document.getElementById("root")!;
  const root = createRoot(el);
  flushSync(() => root.render(<App />));
  const t0 = performance.now();
  flushSync(() => setId("B"));
  rows=0;ticks=0;paneRenders=0;let running = !!tickEveryMs, last = performance.now(); const ch = new MessageChannel();
  ch.port1.onmessage = () => { if (!running) return; if (performance.now() - last >= tickEveryMs!) { last = performance.now(); ticks++; tick(); } ch.port2.postMessage(0); };
  if (running) ch.port2.postMessage(0); const iv = null;
  let landed: number | null = null;
  while (performance.now() - t0 < waitMs) {
    await new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(0); }; c.port2.postMessage(0); });
    if (el.querySelector("[data-body]")!.getAttribute("data-body") === "B") { landed = performance.now() - t0; break; }
  }
  running = false; ch.port1.close();
  const live = el.querySelector("[data-live]")!.getAttribute("data-live");
  root.unmount();
  micro = 0; return { m, tickEveryMs, rows, ticks, paneRenders, live, landedMs: landed && Math.round(landed) };
}

test("a pane whose store keeps firing never lands a plain deferred switch; the bounded one does", async () => {
  // Every 100 rows (~200ms of a ~300ms render) a store update re-renders the pane.
  const quiet = await run(null, 5000);
  expect(quiet.landedMs).not.toBeNull();
  const starved = await run(null, 3000, 100);
  expect(starved.live).toBe("B");
  expect(starved.landedMs).toBeNull();
  bounded = true;
  const calm = await run(null, 5000);
  expect(calm.landedMs!).toBeLessThan(500);
  const rescued = await run(null, 7000, 100);
  expect(rescued.landedMs).not.toBeNull();
  expect(rescued.landedMs!).toBeLessThan(2500);
  closeDomWindow(dom);
}, 60000);
