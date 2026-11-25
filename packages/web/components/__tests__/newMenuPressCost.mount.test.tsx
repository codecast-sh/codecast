// The header's New menu, pressed: the press itself does no layout work. In a
// replay (ct-101476, rp-25467) the first press on New cost a 551 ms frame, 359
// ms of it layout forced inside the root's pointerdown listener: the press
// opened the menu, drew its rows and measured them in the same event, so a
// long page laid itself out before the menu could paint. A browser forces that
// layout when code reads geometry after a DOM write inside the handler, so the
// check counts every geometry read made while the pointerdown is dispatched.
// It must be zero, and the menu must still open and start a session.
import { describe, expect, test } from "bun:test";
import { installModernDom, styleValue } from "../../test-helpers/modernDom";

const dom = installModernDom("https://app.test/inbox");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../ThemeProvider");
const { NewMenu } = await import("../NewMenu");

// Every geometry read a browser answers by laying out the page.
let recording = false;
const reads: string[] = [];
const proto = dom.window.HTMLElement.prototype as any;
const elProto = dom.window.Element.prototype as any;
// Each read is named by what made it: the first frame's function and module.
const site = () => (new Error().stack?.split("\n")[4] ?? "").trim().replace(/\(.*node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?/, "(").replace(/\/dist\/[^:]+:(\d+):\d+\)/, ":$1)");
const note = (name: string) => { if (recording) reads.push(`${name} ${site()}`); };
for (const [target, name] of [[elProto, "getBoundingClientRect"], [elProto, "getClientRects"]] as const) {
  const real = target[name];
  target[name] = function (this: Element, ...a: unknown[]) { note(name); return real.apply(this, a); };
}
for (const name of ["offsetWidth", "offsetHeight", "offsetTop", "offsetLeft", "clientWidth", "clientHeight", "scrollHeight", "scrollWidth"]) {
  const target = name.startsWith("offset") ? proto : elProto;
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (!d?.get) continue;
  Object.defineProperty(target, name, { configurable: true, get(this: Element) { note(name); return d.get!.call(this); } });
}
const realCS = dom.window.getComputedStyle.bind(dom.window);
const cs = (el: Element, p?: string | null) => { note("getComputedStyle"); return realCS(el, p); };
dom.window.getComputedStyle = cs as any;
(globalThis as any).getComputedStyle = cs;

describe("pressing the header's New", () => {
  test("opens the menu without reading layout inside the press, and Session is one click away", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <ThemeContext.Provider value={styleValue("classic")}><MemoryRouter><NewMenu /></MemoryRouter></ThemeContext.Provider>,
    ));
    const button = host.querySelector('[aria-label="New"]') as HTMLElement;
    expect(button).toBeTruthy();

    // The press, as a mouse sends it, outside act so React commits the way a
    // browser does: a discrete event's update flushes in the microtask right
    // after the listener, which the browser bills to the same pointerdown.
    // Only what runs before that microtask checkpoint ends counts.
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    recording = true;
    button.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ctrlKey: false }) as any);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    recording = false;
    button.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }) as any);
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as any);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    // Let a deferred open (a frame, a transition) finish.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const rows = [...document.querySelectorAll('[role="menuitem"]')].map((r) => r.textContent ?? "");
    expect(rows.some((t) => t.startsWith("Session"))).toBe(true);
    expect(reads).toEqual([]);

    await act(async () => root.unmount());
    host.remove();
  });
});
