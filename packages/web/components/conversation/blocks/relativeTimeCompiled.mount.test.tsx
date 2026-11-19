// A relative time on a transcript row keeps moving when the row is compiled.
//
// React Compiler caches `relativeTime(timestamp)` in a row on the callback and
// the timestamp. useRelativeTime once returned the same callback for the life
// of the row and read Date.now() inside it, so a compiled session-message card
// drawn at "just now" still said "just now" five minutes and a new body later.
// Plain `bun test` runs these rows as written, where that never showed; the
// last test here runs this file again with REACT_COMPILER=1, so the compiled
// rows are checked wherever the file is run.
// Run: bun test components/conversation/blocks/relativeTimeCompiled.mount.test.tsx
import { afterAll, afterEach, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { reactCompilerActive } from "../../../test-helpers/reactCompiler";

const START = Date.UTC(2026, 10, 18, 12);
const realNow = Date.now;
let clock = START;
let dom: any;

async function mount() {
  if (!dom) {
    const { JSDOM } = await import("jsdom");
    dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
    for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
      Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
    }
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  }
  clock = START;
  Date.now = () => clock;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { MemoryRouter } = await import("react-router");
  const { ConvexProvider } = await import("convex/react");
  const { heroConvexStub } = await import("../../../app/(marketing)/heroFly/convexStub");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (node: React.ReactNode) => React.act(() => {
    root.render(<ConvexProvider client={heroConvexStub}><MemoryRouter>{node}</MemoryRouter></ConvexProvider>);
  });
  return { React, render, host, unmount: () => React.act(() => root.unmount()) };
}

afterEach(() => { Date.now = realNow; });
afterAll(() => { if (dom) closeDomWindow(dom); });

const compiled = (fn: unknown) => /\$\[\d+\]/.test(String(fn));

test("a session-message card's age moves on when it draws again with a new body", async () => {
  const { SessionMessageBlock } = await import("./systemBlocks");
  // Under REACT_COMPILER=1 this must be the compiled card, or the test proves nothing.
  expect(compiled(SessionMessageBlock)).toBe(reactCompilerActive);
  const m = await mount();
  const sent = START - 5_000;
  await m.render(<SessionMessageBlock from="jx7aaaa" body="First report." timestamp={sent} />);
  expect(m.host.querySelector("[data-cc-row-meta]")!.textContent).toBe("just now");

  clock = START + 5 * 60_000;
  await m.render(<SessionMessageBlock from="jx7aaaa" body="Second report, same message." timestamp={sent} />);
  expect(m.host.textContent).toContain("Second report");
  expect(m.host.querySelector("[data-cc-row-meta]")!.textContent).toBe("5m ago");
  await m.unmount();
});

test("a vault-ready line's age moves on when it draws again", async () => {
  const { VaultReadyLine } = await import("./VaultRequestCard");
  const m = await mount();
  const at = START - 5_000;
  const line = (text: string) => <VaultReadyLine vault={{ id: "sec-1", name: "STRIPE_KEY", text } as any} timestamp={at} />;
  await m.render(line("ready"));
  expect(m.host.querySelector("[data-cc-row-meta]")!.textContent).toContain("just now");

  clock = START + 3 * 60 * 60_000;
  await m.render(line("ready, said again"));
  expect(m.host.querySelector("[data-cc-row-meta]")!.textContent).toContain("3h ago");
  await m.unmount();
});

test("useRelativeTime hands out a new callback once the clock has moved, and the same one under a fixed instant", async () => {
  const { RelativeTimeNow, useRelativeTime } = await import("../../../lib/conversationFormat");
  const m = await mount();
  const seen: Array<(ts: number) => string> = [];
  function Probe() { seen.push(useRelativeTime()); return null; }

  await m.render(<Probe />);
  clock = START + 60_000;
  await m.render(<Probe />);
  expect(seen[1]).not.toBe(seen[0]);
  expect(seen[1](START)).toBe("1m ago");

  // A film of fixtures fixes the instant: its labels depend on the fixtures alone.
  seen.length = 0;
  await m.render(<RelativeTimeNow.Provider value={START}><Probe /></RelativeTimeNow.Provider>);
  clock = START + 10 * 60_000;
  await m.render(<RelativeTimeNow.Provider value={START}><Probe /></RelativeTimeNow.Provider>);
  expect(seen[1]).toBe(seen[0]);
  expect(seen[1](START - 2 * 60_000)).toBe("2m ago");
  await m.unmount();
});

// CI runs plain `bun test`, which never compiles. This runs the file again
// with the compiler on, so the rows above are also checked as the build ships them.
test.skipIf(reactCompilerActive)("the same holds with the rows compiled (REACT_COMPILER=1)", () => {
  const run = Bun.spawnSync(["bun", "test", "--timeout", "120000", import.meta.path], {
    cwd: `${import.meta.dir}/../../..`, env: { ...process.env, REACT_COMPILER: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const output = run.stdout.toString() + run.stderr.toString();
  expect({ exitCode: run.exitCode, output: run.exitCode === 0 ? "" : output.slice(-3000) }).toEqual({ exitCode: 0, output: "" });
}, 180_000);
