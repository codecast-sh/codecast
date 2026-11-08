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

// Hermes has no `crypto` at all, and the shared web store mints request ids
// with a bare crypto.randomUUID() (sendEscape, stopAndSend, batch ids). Called
// from a press handler, that ReferenceError is a fatal JS error in a release
// build: pressing Stop on a working session closed the app (2026-11-06).
// These ids dedupe commands; they are not secrets. getRandomValues is used
// when something provides it, Math.random otherwise.
const g = global as any;
if (typeof g.crypto?.randomUUID !== "function") {
  const cryptoObj = g.crypto ?? {};
  const bytes = (): Uint8Array => {
    const b = new Uint8Array(16);
    if (typeof cryptoObj.getRandomValues === "function") cryptoObj.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  };
  cryptoObj.randomUUID = (): string => {
    const b = bytes();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  if (!g.crypto) g.crypto = cryptoObj;
}

export {};
