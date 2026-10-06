import { afterAll, expect, test } from "bun:test";
import { act, useRef } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Follow mode's in-page half, mounted: a scroll region reports where the
// leader is, the leader hook composes it, and a follower's region lands on
// the same fraction even when it is a different height.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
// jsdom lays nothing out: an attached element counts as on screen, and each
// scroller says how tall it is through data attributes.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get(this: HTMLElement) {
    return this.isConnected && !this.hidden ? this.parentElement : null;
  },
});
for (const [prop, attr] of [["scrollHeight", "data-sh"], ["clientHeight", "data-ch"]] as const) {
  Object.defineProperty(dom.window.HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.getAttribute(attr) ?? 0);
    },
  });
}
const { createRoot } = await import("react-dom/client");
const { useFollowScroll, useLeaderView } = await import("../useFollowSurface");
const { applyFollowView } = await import("../../lib/follow");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let seen: { sig: string; view: unknown } = { sig: "", view: undefined };

function Doc({ height, hidden = false }: { height: number; hidden?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFollowScroll("doc", ref);
  return <div ref={ref} hidden={hidden} data-testid="doc" data-sh={height} data-ch={500} />;
}

function Leader() {
  seen = useLeaderView(true);
  return null;
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

test("a leader's scroll reaches the composed view; a follower's region lands on the same passage", async () => {
  const leader = await render(<><Doc height={2500} /><Leader /></>);
  const el = leader.container.querySelector<HTMLElement>("[data-testid=doc]")!;
  await act(async () => {
    el.scrollTop = 800;
    el.dispatchEvent(new dom.window.Event("scroll"));
  });
  expect(seen.view).toEqual({ scroll: { key: "doc", offset: 0.4 } });
  const view = seen.view as any;
  await leader.unmount();

  // The follower's window is shorter: the same 40% is a different pixel.
  const follower = await render(<Doc height={1500} />);
  const fel = follower.container.querySelector<HTMLElement>("[data-testid=doc]")!;
  expect(applyFollowView(view)).toBeNull();
  expect(fel.scrollTop).toBe(400);
  // A region of another key takes nothing and leaves the part for its owner.
  expect(applyFollowView({ scroll: { key: "pr", offset: 0.5 } })).toEqual({ scroll: { key: "pr", offset: 0.5 } });
  await follower.unmount();
});

test("a hidden copy (a background tab) neither reports nor takes the scroll", async () => {
  const r = await render(<><Doc height={2500} hidden /><Leader /></>);
  expect(seen.view).toBeUndefined();
  expect(applyFollowView({ scroll: { key: "doc", offset: 0.5 } })).toEqual({ scroll: { key: "doc", offset: 0.5 } });
  await r.unmount();
});
