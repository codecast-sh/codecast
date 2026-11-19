// Which desktop window this renderer is, for code that must stay free of the
// desktop bridge's imports (the phone bundle reaches some of its callers).
// Outside a browser every answer is the plain app window.

/** This renderer IS the call panel: it hosts the call and draws the stage. */
export function isCallPanelWindow(): boolean {
  return typeof window !== "undefined" && window.__CODECAST_ELECTRON__?.isCallPanelWindow === true;
}

/** This renderer is the command palette's window. */
export function isPaletteWindow(): boolean {
  return typeof window !== "undefined" && !!window.location?.pathname?.startsWith("/palette");
}

/** Whether this window ever draws a conversation's transcript: the palette and
 *  the call panel never do, so they keep no message cache warm. */
export function windowDrawsTranscripts(): boolean {
  return !isCallPanelWindow() && !isPaletteWindow();
}

// Desktop windows run with background throttling off (the live socket must
// keep delivering while a window sits unfocused), which in Electron also pins
// document.visibilityState at "visible". A minimized window, one on another
// desktop, or the warm spare then read as on screen, and every "skip this
// while hidden" check in the app ran anyway. The shell knows which windows are
// shown and says so in the window role; this makes the document report it and
// announce each change the way a browser does. Timers stay unthrottled.
let shellShown: boolean | null = null;
let shellVisibilityInstalled = false;

export function applyShellVisibility(shown: boolean | null): void {
  if (typeof document === "undefined" || shown === null || shown === shellShown) return;
  if (!shellVisibilityInstalled) {
    shellVisibilityInstalled = true;
    const proto = Object.getPrototypeOf(document);
    const nativeState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ?? Object.getOwnPropertyDescriptor(proto, "visibilityState");
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden") ?? Object.getOwnPropertyDescriptor(proto, "hidden");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get() { return shellShown === false ? "hidden" : nativeState?.get?.call(document) ?? "visible"; },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get() { return shellShown === false ? true : nativeHidden?.get?.call(document) ?? false; },
    });
  }
  const was = document.visibilityState;
  shellShown = shown;
  if (document.visibilityState !== was) document.dispatchEvent(new Event("visibilitychange"));
}
