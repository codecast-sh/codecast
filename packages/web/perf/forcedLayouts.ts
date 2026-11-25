// ct-101461: a conversation switch, a diff panel toggle and a send each
// stalled Chrome for a quarter to a third of a second, most of it forced
// layout. The page has to be laid out once after an action anyway. Every
// further layout read that follows a DOM write lays the whole page out again,
// synchronously. So each action may force layout at most once: batch the reads
// before the writes, or move them into the next frame.
//
//   bun perf/forcedLayouts.ts <switch|diff-toggle|send>
//
// It builds the warm switch world from harness.tsx (two conversations of 200
// cached messages over 2,000 sessions) and adds what the harness lacks: it
// counts a layout read as forced when the DOM changed since the page was last
// laid out, either by the previous forced read or by an animation frame. The
// failure names each forcing read by its file and line. Each workload runs in
// its own process, as budgets.ts runs them.
const only = process.argv[2];
const WORKLOADS = ["switch", "diff-toggle", "send"];
if (!only || !WORKLOADS.includes(only)) {
  console.error(`usage: bun perf/forcedLayouts.ts <${WORKLOADS.join("|")}>`);
  process.exit(2);
}

const { setup, run, reset } = await import("./harness");
const g = globalThis as any;
const win = g.window;

// --- Forced layout tracking, layered over the harness's fake geometry -------

// Named by the first app frame, or the diff viewer's own frame.
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").find((l) => (l.includes("/packages/web/") && !l.includes("/perf/") && !l.includes("/node_modules/")) || l.includes("/@pierre/diffs/"))?.trim().replace(/^at /, "").replace(/\(\/\S*\/packages\/web\//, "(").replace(/\/\S*\/node_modules\//, "") ?? "?"}`;
let forced: string[] = [];
let dirty = false;
const watcher = new win.MutationObserver(() => { dirty = true; });
const watch = (node: Node) => watcher.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
watch(win.document);
const layoutRead = (name: string) => {
  if (watcher.takeRecords().length > 0 || dirty) forced.push(readSite(name));
  dirty = false;
};
// A frame lays the page out, so reads at its start are free.
const laidOut = () => { watcher.takeRecords(); dirty = false; };

const proto = win.HTMLElement.prototype;
for (const prop of ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth", "scrollHeight", "scrollWidth", "offsetTop"]) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop)!;
  Object.defineProperty(proto, prop, { ...desc, get(this: HTMLElement) { layoutRead(prop); return desc.get!.call(this); } });
}
const rect = proto.getBoundingClientRect;
proto.getBoundingClientRect = function (this: HTMLElement) { layoutRead("getBoundingClientRect"); return rect.call(this); };
const computed = g.getComputedStyle;
const getComputedStyle = (el: Element, pseudo?: string) => { layoutRead("getComputedStyle"); return computed(el, pseudo); };
g.getComputedStyle = getComputedStyle;
win.getComputedStyle = getComputedStyle;
for (const target of [g, win]) {
  const raf = target.requestAnimationFrame;
  if (typeof raf === "function") target.requestAnimationFrame = (cb: FrameRequestCallback) => raf((t: number) => { laidOut(); cb(t); });
}
const attach = win.Element.prototype.attachShadow;
win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
  const shadow = attach.call(this, init);
  watch(shadow);
  return shadow;
};
// Chrome's answer (the replays that timed these stalls are Chrome's): the
// composer sizes itself with field-sizing, so its Safari fallback, which
// measures the box in script, never runs.
const css = { supports: (prop: string, value?: string) => prop === "field-sizing" && value === "content", escape: (s: string) => s };
g.CSS = css;
win.CSS = css;

// --- Driving the actions ----------------------------------------------------

const { act } = await import("react");
const doc = win.document as Document;
const pause = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
// Quiet: nothing in the page changed for 150ms.
async function settle(maxMs = 10_000) {
  const deadline = Date.now() + maxMs;
  let changed = true;
  const mo = new win.MutationObserver(() => { changed = true; });
  mo.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  while (changed && Date.now() < deadline) { changed = false; await pause(150); }
  mo.disconnect();
}
async function until(check: () => boolean, what: string, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(10);
  }
}
async function count(action: () => Promise<unknown>): Promise<string[]> {
  forced = [];
  await action();
  return forced;
}

type Action = { name: string; run: () => Promise<string[]> };
async function actions(): Promise<Action[]> {
  await setup("switch");
  await settle();
  if (only === "switch") {
    return [
      { name: "a warm conversation switch", run: () => count(run) },
    ];
  }
  if (only === "diff-toggle") {
    const { useDiffViewerStore } = await import("../store/diffViewerStore");
    const toggle = async () => { await act(async () => { useDiffViewerStore.getState().toggleDiffPanel(); }); await settle(); };
    // Open and close once untimed, so each counted press is a warm one.
    await toggle();
    await toggle();
    return [
      { name: "opening the diff panel", run: () => count(toggle) },
      { name: "closing the diff panel", run: () => count(toggle) },
    ];
  }
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!;
  const box = () => doc.querySelector("textarea") as HTMLTextAreaElement;
  const type = async (text: string) => {
    await act(async () => { const ta = box(); ta.focus(); setValue.call(ta, text); ta.dispatchEvent(new win.Event("input", { bubbles: true })); });
    await settle();
  };
  const send = async (text: string) => {
    await act(async () => { box().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); });
    // Drawn in the transcript, and the box empty.
    await until(() => box().value === "" && [...doc.querySelectorAll("[data-vkey]")].some((row) => row.textContent!.includes(text)), "the sent message to draw");
    await settle();
  };
  await type("Warm-up send 0, untimed.");
  await send("Warm-up send 0, untimed.");
  let n = 0;
  const measured = { name: "sending a message", run: async () => { const text = `Measured send ${++n}: look at the sync layer again.`; await type(text); return count(() => send(text)); } };
  return [measured, measured];
}

const tally = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].map(([x, k]) => k > 1 ? `${x} x${k}` : x);
let failed = false;
const t0 = performance.now();
for (const a of await actions()) {
  for (let i = 0; i < (only === "switch" ? 2 : 1); i++) {
    const reads = await a.run();
    if (only === "switch") await reset();
    if (reads.length > 1) {
      failed = true;
      console.log(`FAIL  ${a.name} forces layout ${reads.length} times, at most 1 allowed:\n  ${tally(reads).join("\n  ")}`);
    } else {
      console.log(`pass  ${a.name} forces layout ${reads.length} time${reads.length === 1 ? "" : "s"}`);
    }
  }
}
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(failed ? 1 : 0);
