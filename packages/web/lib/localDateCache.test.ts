import { describe, expect, test, spyOn } from "bun:test";
import { cacheLocalDateFormat } from "./localDateCache";

describe("local date formatting cache", () => {
  test("keeps the exact locale output, including invalid timestamps", () => {
    const format = (date: Date) => date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const cached = cacheLocalDateFormat(format);
    for (const ts of [Date.UTC(2026, 0, 5, 12), Date.UTC(2026, 6, 5, 12), NaN, Infinity]) {
      expect(cached(ts)).toBe(format(new Date(ts)));
      expect(cached(ts)).toBe(format(new Date(ts)));
    }
  });

  test("reuses recent timestamps and evicts old entries at its bound", () => {
    let calls = 0;
    const cached = cacheLocalDateFormat((date) => { calls++; return date.toISOString(); });
    for (let i = 0; i < 512; i++) cached(i);
    cached(0);
    cached(512);
    cached(0);
    expect(calls).toBe(513);
    cached(1);
    expect(calls).toBe(514);
  });

  test("recomputes when the timestamp's local timezone offset changes", () => {
    const offset = spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(240);
    const cached = cacheLocalDateFormat((date) => String(date.getTimezoneOffset()));
    try {
      expect(cached(0)).toBe("240");
      offset.mockReturnValue(300);
      expect(cached(0)).toBe("300");
    } finally {
      offset.mockRestore();
    }
  });

  test("recomputes after a browser language change", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const cached = cacheLocalDateFormat(() => navigator.language);
    try {
      Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
      expect(cached(0)).toBe("en-US");
      Object.defineProperty(globalThis, "navigator", { value: { language: "fr-FR" }, configurable: true });
      expect(cached(0)).toBe("fr-FR");
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else delete (globalThis as any).navigator;
    }
  });
});
