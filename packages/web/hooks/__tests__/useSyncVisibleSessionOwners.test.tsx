// The visible cards' owners feeder: it reads only the cards in the viewport,
// asks only for server ids (an optimistic stub's key would refuse its chunk),
// and a scroll reads again only the chunks whose members changed.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><div id="root"></div><div id="cards"></div>', { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "Node"]) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// An observer the test drives: `show(ids)` puts exactly those cards on screen.
const observed = new Set<Element>();
let fire: ((entries: any[]) => void) | null = null;
(globalThis as any).IntersectionObserver = class {
  constructor(cb: (entries: any[]) => void) { fire = cb; }
  observe(el: Element) { observed.add(el); }
  unobserve(el: Element) { observed.delete(el); }
  disconnect() {}
};
const show = (ids: string[]) => fire!([...observed].map((el, i) => ({ target: el, isIntersecting: ids.includes(el.getAttribute("data-session-id")!), boundingClientRect: { top: i * 50 } })));

let asked: Record<string, any> = {};
const convex = await import("convex/react");
afterAll(() => mock.module("convex/react", () => convex));
mock.module("convex/react", () => ({ ...convex, useQueries: (q: Record<string, any>) => { asked = q; return {}; } }));
const authSettled = { ...(await import("../useServerAuthSettled")) };
afterAll(() => mock.module("../useServerAuthSettled", () => authSettled));
mock.module("../useServerAuthSettled", () => ({ ...authSettled, useServerAuthSettled: () => true }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { closeDomWindow } = await import("../../test-helpers/domGlobals");
const { holdOwnerCard, watchOwnerCard } = await import("../../lib/visibleOwnerCards");
const { rechunk, chunkReads } = await import("../../lib/ownerChunks");
const { useSyncVisibleSessionOwners } = await import("../useSyncVisibleSessionOwners");

const root = createRoot(document.getElementById("root")!);
afterAll(async () => { await act(async () => root.unmount()); closeDomWindow(dom); });
function Feeder() { useSyncVisibleSessionOwners(); return null; }
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const askedIds = () => Object.values(asked).flatMap((q: any) => q.args.conversation_ids).sort();
const id = (i: number) => `jx7${String(i).padStart(29, "0")}`;

beforeEach(async () => { await act(async () => root.render(<Feeder />)); });

test("of 100 mounted cards, only the ones in the viewport are read", async () => {
  const cards = document.getElementById("cards")!;
  const releases = Array.from({ length: 100 }, (_, i) => {
    const el = document.createElement("div");
    el.setAttribute("data-session-id", id(i));
    cards.appendChild(el);
    return watchOwnerCard(el, id(i));
  });
  await act(async () => show([id(3), id(4), id(5), id(6)]));
  await wait(450);
  expect(askedIds()).toEqual([id(3), id(4), id(5), id(6)]);
  await act(async () => show([id(5), id(6), id(7)]));
  await wait(450);
  expect(askedIds()).toEqual([id(5), id(6), id(7)]);
  for (const release of releases) release();
  cards.innerHTML = "";
  await wait(450);
  expect(askedIds()).toEqual([]);
});

test("a stub id among the visible cards is left out, and an unchanged chunk keeps its args", async () => {
  const A = "a".repeat(32), B = "b".repeat(32);
  const releases = [holdOwnerCard(B), holdOwnerCard("optimistic-stub-1"), holdOwnerCard(A)];
  await wait(450);
  expect(askedIds()).toEqual([A, B]);
  // useQueries resubscribes a key only when its args change.
  const before = JSON.stringify(asked);
  releases[1]();
  await wait(450);
  expect(JSON.stringify(asked)).toBe(before);
  for (const release of releases) release();
  await wait(450);
});

test("a scroll reads again only the chunks it changed: far fewer reads than one batch of every visible id", () => {
  const all = Array.from({ length: 300 }, (_, i) => id(i));
  for (const window of [12, 60]) {
    let chunks = rechunk([], all.slice(0, window));
    let reads = 0, batch = 0;
    for (let k = 1; k <= 40; k++) {
      const ids = all.slice(k * 3, k * 3 + window);
      const next = rechunk(chunks, ids);
      reads += chunkReads(chunks, next);
      batch += ids.length;
      chunks = next;
      expect(chunks.length).toBeLessThanOrEqual(2 * Math.ceil(window / 5) + 1);
    }
    expect(reads).toBeLessThan(batch * (window === 12 ? 0.6 : 0.15));
  }
});
