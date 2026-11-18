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
