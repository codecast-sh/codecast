// Hermes lacks a handful of web globals that browser-first libraries touch at
// MODULE EVALUATION time (not call time), so this file must be the FIRST
// import of app/_layout.tsx — import order is execution order, and
// expo-router eagerly requires every route module after the layout.
// Concretely: @livekit/react-native references DOMException while its module
// body runs; without this, importing it anywhere (team tab → callManager)
// killed the whole app at boot. See memory: shared_web_code_hermes_traps.

if (typeof (global as any).DOMException === "undefined") {
  class DOMExceptionPolyfill extends Error {
    code: number;
    constructor(message?: string, name?: string) {
      super(message);
      this.name = name || "Error";
      this.code = 0;
    }
  }
  (global as any).DOMException = DOMExceptionPolyfill;
}

export {};
