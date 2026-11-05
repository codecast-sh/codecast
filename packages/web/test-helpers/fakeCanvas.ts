// jsdom has no canvas: give every canvas a 2D context whose calls do nothing, so
// a chart library can mount and draw, and a test reads the HTML around it.
export function installFakeCanvas(win: { HTMLCanvasElement: { prototype: { getContext: unknown } } }): void {
  const ctx = (): unknown => {
    const store: Record<string | symbol, unknown> = { canvas: null };
    return new Proxy(store, {
      get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s: string) => ({ width: String(s).length * 6 }) : k === "getImageData" || k === "createImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : () => ctx()),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  };
  win.HTMLCanvasElement.prototype.getContext = function () { return ctx(); };
}
