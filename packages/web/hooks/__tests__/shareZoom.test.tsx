// A share read at 1:1 is one share pixel per screen pixel, pans by dragging,
// and goes back to fitted on the same button.
import { afterAll, expect, test } from "bun:test";
import { act, useRef } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(dom.window as any).devicePixelRatio = 2;
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useShareZoom } = await import("../useShareZoom");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let zoom: ReturnType<typeof useShareZoom>;
function Probe({ enabled }: { enabled: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  zoom = useShareZoom(boxRef, scrollRef, { width: 2560, height: 1440 }, enabled);
  return (
    <div ref={boxRef}>
      <div ref={scrollRef} data-scroller {...zoom.panHandlers} />
    </div>
  );
}

test("1:1 sizes the share to its own pixels over devicePixelRatio, and drag pans it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<Probe enabled />));
    expect(zoom.actual).toBe(false);
    expect(zoom.actualSize).toBeNull();

    await act(() => zoom.toggleActual());
    expect(zoom.actualSize).toEqual({ width: 1280, height: 720 });

    const el = container.querySelector("[data-scroller]") as HTMLElement & { setPointerCapture: (id: number) => void };
    el.setPointerCapture = () => {};
    el.scrollLeft = 100;
    el.scrollTop = 50;
    const h = zoom.panHandlers as Required<typeof zoom.panHandlers>;
    h.onPointerDown!({ button: 0, clientX: 300, clientY: 300, pointerId: 1 } as any);
    h.onPointerMove!({ clientX: 260, clientY: 280 } as any);
    expect(el.scrollLeft).toBe(140);
    expect(el.scrollTop).toBe(70);
    h.onPointerUp!({} as any);
    h.onPointerMove!({ clientX: 0, clientY: 0 } as any);
    expect(el.scrollLeft).toBe(140);

    await act(() => zoom.toggleActual());
    expect(zoom.actualSize).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

test("a tile that is not zoomable never goes 1:1", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<Probe enabled={false} />));
    await act(() => zoom.toggleActual());
    expect(zoom.actual).toBe(false);
    expect(zoom.panHandlers).toEqual({});
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
