// Park the endless CSS animations while a desktop window is in the background.
//
// The desktop app runs with backgroundThrottling disabled (electron/main.js)
// so the live-query socket keeps delivering while a window is hidden. The side
// effect is that Chromium keeps compositing every endless animation (the
// per-session pulse, ping and spin dots) at the display's refresh rate behind
// another app, pinning the GPU process for nothing anyone can see.
//
// This used to be one attribute on <html> and one rule, `html[data-idle] *`.
// A rule whose subject is every element makes the browser restyle the whole
// page each time the attribute flips: measured in a busy window, about 38 ms
// on every focus and every blur, the first of them just as the person clicks
// back in. Pausing the animations themselves touches no style: the ones that
// are running and never end are paused, anything that starts while the window
// is away is paused as it starts, and all of them resume on the way back.
// An animation the app paused itself is left as it was.

type Pausable = Pick<Animation, "playState" | "pause" | "play"> & { effect: Pick<AnimationEffect, "getComputedTiming"> | null };

type IdleDocument = {
  hasFocus(): boolean;
  visibilityState: string;
  getAnimations(): Pausable[];
  addEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: Event) => void, capture?: boolean): void;
};

type IdleWindow = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

function endless(animation: Pausable): boolean {
  try {
    return animation.effect?.getComputedTiming().iterations === Infinity;
  } catch {
    return false;
  }
}

/** Start following the window's focus and visibility. Returns the uninstall. */
export function followWindowIdle(doc: IdleDocument, win: IdleWindow): () => void {
  const held = new Set<Pausable>();
  let idle = false;

  const hold = (animation: Pausable) => {
    if (animation.playState !== "running" || !endless(animation)) return;
    try {
      animation.pause();
      held.add(animation);
    } catch {
      // an animation whose element just left the page
    }
  };

  // An element that mounts while the window is away starts its animation then.
  const onStart = (event: Event) => {
    const target = event.target as { getAnimations?: (options?: { subtree: boolean }) => Pausable[] } | null;
    for (const animation of target?.getAnimations?.({ subtree: true }) ?? []) hold(animation);
  };

  const update = () => {
    const next = !doc.hasFocus() || doc.visibilityState === "hidden";
    if (next === idle) return;
    idle = next;
    if (idle) {
      for (const animation of doc.getAnimations()) hold(animation);
      doc.addEventListener("animationstart", onStart, true);
      return;
    }
    doc.removeEventListener("animationstart", onStart, true);
    for (const animation of held) {
      try {
        if (animation.playState === "paused") animation.play();
      } catch {
        // gone with its element
      }
    }
    held.clear();
  };

  win.addEventListener("focus", update);
  win.addEventListener("blur", update);
  doc.addEventListener("visibilitychange", update);
  update();
  return () => {
    win.removeEventListener("focus", update);
    win.removeEventListener("blur", update);
    doc.removeEventListener("visibilitychange", update);
    doc.removeEventListener("animationstart", onStart, true);
    for (const animation of held) {
      try {
        if (animation.playState === "paused") animation.play();
      } catch {
        // gone with its element
      }
    }
    held.clear();
  };
}
