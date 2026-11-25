// ct-101413: the vault index's first build must not freeze the page.
//
// Opening the files page on a large vault mounts a component that subscribes
// to the index (useVaultIndexVersion), which kicks off the first build. That
// build used to run as ONE idle callback that parsed every note without
// yielding: ~5 s of blocked main thread on a real vault, with clicks queued up
// behind it. This test mounts the hook over a 5,000-note vault, runs a 5 ms
// heartbeat beside the build, and measures the longest stretch the event loop
// went without a turn. Whatever the build does to stay responsive (chunked idle
// callbacks, yields, a worker), no single block may exceed the 200 ms a click
// can wait, and the finished index must hold every note.

import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const NOTES = 5000;
const MAX_BLOCK_MS = 200;

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });

/** A browser-shaped requestIdleCallback: runs on a later task with a ~50 ms
 *  deadline, so a build that honours timeRemaining() behaves as it would in
 *  Chrome. */
function requestIdleCallbackShim(cb: IdleRequestCallback): number {
  return setTimeout(() => {
    const start = performance.now();
    cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (performance.now() - start)) });
  }, 1) as unknown as number;
}

const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestIdleCallback: requestIdleCallbackShim,
  cancelIdleCallback: (id: number) => clearTimeout(id),
});
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useVaultStore } = await import("../../../store/vaultStore");
const { useVaultIndexVersion, vaultIndex } = await import("../indexHost");

afterAll(() => {
  restoreGlobals();
  closeDomWindow(dom);
});

function syntheticVault(n: number): Record<string, { content: string; mtime: number; etag: string }> {
  const bodies: Record<string, { content: string; mtime: number; etag: string }> = {};
  for (let i = 0; i < n; i++) {
    const content = [
      "---",
      `tags: [area/${i % 17}, kind/${i % 5}]`,
      `aliases: [Alias ${i}]`,
      "---",
      `# Note ${i}`,
      "",
      `Links to [[Note ${(i + 1) % n}]], [[Note ${(i * 7) % n}#Section]] and [[Alias ${(i * 13) % n}|an alias]]. #topic/${i % 11}`,
      "",
      "## Section",
      "",
      "- [ ] a task with some words in it to index for search",
      "- [x] a finished task ^block" + i,
      "",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(4),
      "",
      "### Details",
      "",
      `More text referencing [[Folder ${i % 40}/Sub ${i}]] and ![[image-${i}.png]].`,
    ].join("\n");
    bodies[`Folder ${i % 40}/Note ${i}.md`] = { content, mtime: 1, etag: `e${i}` };
  }
  return bodies;
}

test("the first index build of a 5,000-note vault never blocks the main thread for more than 200 ms", async () => {
  useVaultStore.setState({ activeVaultId: "big", bodies: syntheticVault(NOTES) });

  let last = performance.now();
  let longest = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 5);

  function Probe() {
    useVaultIndexVersion();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  last = performance.now(); // measure the build, not React's mount

  const deadline = Date.now() + 60_000;
  while (vaultIndex.paths().length < NOTES && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 20)); // one more heartbeat after the last chunk
  clearInterval(heartbeat);
  await act(async () => root.unmount());

  expect(vaultIndex.paths().length).toBe(NOTES);
  expect(vaultIndex.backlinks("Folder 1/Note 1.md").length).toBeGreaterThan(0);
  expect(Math.round(longest)).toBeLessThanOrEqual(MAX_BLOCK_MS);
}, 90_000);
