import { useRef } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import type { LiveViewProps } from "../live/registry";
import type { BoardEl } from "./boardTypes";
import { fitBox } from "./boardFrame";
import { pinPoints, type useThreads } from "./commentThreads";
import type { useBoardCamera } from "./useBoardCamera";

type Insets = { top: number; bottom: number; right: number };

// Until the person moves the camera, the opening frame (a fit, or the camera
// this tab left the board at) follows the pane: a resize (a side panel
// opening, the window narrowing) frames the content again.
export function useBoardOpeningFit({ cam, live, elements, byKey, threads, chromeInsets }: {
  cam: ReturnType<typeof useBoardCamera>;
  live: LiveViewProps["live"];
  elements: BoardEl[];
  byKey: Map<string, BoardEl>;
  threads: ReturnType<typeof useThreads>;
  chromeInsets: () => Insets;
}) {
  const fitted = useRef(cam.hadSaved.current);
  const autoCam = useRef<{ x: number; y: number; z: number } | null>(null);
  const lastFit = useRef<{ w: number; h: number; ready: boolean; count: number } | null>(null);
  useWatchEffect(() => {
    if (!cam.viewport.w) return;
    if (!live.ready && elements.length === 0) return;
    // A camera saved in a pane of another size (a narrow split, a smaller window) would open off frame.
    const was = cam.savedFor.current;
    if (was) {
      cam.savedFor.current = null;
      if (Math.abs(was.w - cam.viewport.w) > was.w * 0.1 || Math.abs(was.h - cam.viewport.h) > was.h * 0.1) fitted.current = false;
      else {
        // Kept as the opening frame: it stays, and follows the pane until the person moves it.
        autoCam.current = { ...cam.cam.current };
        return;
      }
    }
    const c = cam.cam.current;
    const untouched = autoCam.current && c.x === autoCam.current.x && c.y === autoCam.current.y && c.z === autoCam.current.z;
    if (fitted.current && !untouched) return;
    // Once the board has loaded, a new element is someone's edit, not more of the board arriving:
    // the view stays put (only a pane resize frames it again).
    // (A board that was empty at that fit, like a fresh duplicate whose copy lands a moment later, still fits its first content.)
    const last = lastFit.current;
    if (fitted.current && last && last.ready && last.count > 0 && last.w === cam.viewport.w && last.h === cam.viewport.h) return;
    fitted.current = true;
    cam.fit(fitBox(elements, byKey, pinPoints(threads, byKey).values()), { instant: true, minReadable: true, insets: chromeInsets() });
    autoCam.current = { ...cam.cam.current };
    lastFit.current = { w: cam.viewport.w, h: cam.viewport.h, ready: live.ready, count: elements.length };
  }, [cam.viewport.w, cam.viewport.h, live.ready, elements.length]);
}
