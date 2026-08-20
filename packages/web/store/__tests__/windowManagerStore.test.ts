import { beforeEach, describe, expect, it } from "bun:test";
import { useWindowManager } from "../windowManagerStore";

// The window's visual state is one enum plus a restoreTo hint captured at
// minimize time. The old pair of independent minimized/maximized booleans
// permitted {true,true} and reproducibly lost the maximized state:
// maximize→minimize→taskbar-restore came back SMALL because minimize never
// read maximized and restore cleared both flags and applied prevBounds.

const VIEWPORT = { width: 1600, height: 900 };
const BOUNDS = { x: 40, y: 40, width: 520, height: 480 };

function win(id: string) {
  return useWindowManager.getState().windows[id];
}

describe("windowManagerStore visual state", () => {
  beforeEach(() => {
    useWindowManager.getState().closeAll();
  });

  it("maximize→minimize→restore returns to MAXIMIZED (the broken case)", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.maximizeWindow(id, VIEWPORT);
    s.minimizeWindow(id);
    expect(win(id).visualState).toBe("minimized");
    expect(win(id).restoreTo).toBe("maximized");

    s.restoreWindow(id);
    expect(win(id).visualState).toBe("maximized");
    expect(win(id)).toMatchObject({ x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });

    // A second restore (the un-maximize toggle) returns to the pre-maximize bounds.
    s.restoreWindow(id);
    expect(win(id).visualState).toBe("normal");
    expect(win(id)).toMatchObject(BOUNDS);
    expect(win(id).prevBounds).toBeUndefined();
  });

  it("minimize from normal → restore returns to normal bounds", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.minimizeWindow(id);
    expect(win(id).visualState).toBe("minimized");
    expect(win(id).restoreTo).toBe("normal");

    s.restoreWindow(id);
    expect(win(id).visualState).toBe("normal");
    expect(win(id)).toMatchObject(BOUNDS);
  });

  it("a stale prevBounds does not snap a dragged window back on minimize→restore", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.maximizeWindow(id, VIEWPORT);
    s.restoreWindow(id); // back to normal
    s.updatePosition(id, 200, 120); // drag it somewhere else
    s.minimizeWindow(id);
    s.restoreWindow(id);
    expect(win(id).visualState).toBe("normal");
    expect(win(id)).toMatchObject({ ...BOUNDS, x: 200, y: 120 });
  });

  it("drag while maximized drops to normal", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.maximizeWindow(id, VIEWPORT);
    s.updatePosition(id, 10, 20);
    expect(win(id).visualState).toBe("normal");

    // A plain drag of a normal or minimized window never changes visual state.
    s.minimizeWindow(id);
    s.updateBounds(id, { x: 5, y: 5 });
    expect(win(id).visualState).toBe("minimized");
  });

  it("resize while maximized drops to normal", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.maximizeWindow(id, VIEWPORT);
    s.updateSize(id, 800, 600);
    expect(win(id).visualState).toBe("normal");
  });

  it("autoArrange normalizes every visible window and skips minimized ones", () => {
    const s = useWindowManager.getState();
    const a = s.openWindow("sessA", BOUNDS);
    const b = s.openWindow("sessB", BOUNDS);
    s.maximizeWindow(a, VIEWPORT);
    s.minimizeWindow(b);
    s.autoArrange("tile", VIEWPORT);
    expect(win(a).visualState).toBe("normal");
    expect(win(a).prevBounds).toBeUndefined();
    expect(win(b).visualState).toBe("minimized");
  });

  it("openWindow on a minimized session restores it in its pre-minimize state", () => {
    const s = useWindowManager.getState();
    const id = s.openWindow("sess1", BOUNDS);
    s.maximizeWindow(id, VIEWPORT);
    s.minimizeWindow(id);
    const again = s.openWindow("sess1");
    expect(again).toBe(id);
    expect(win(id).visualState).toBe("maximized");
  });
});
