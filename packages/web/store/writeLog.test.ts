import { test, expect, beforeEach } from "bun:test";
import { recordWrite, getWriteLog, _resetWriteLogForTests } from "./writeLog";

beforeEach(() => {
  _resetWriteLogForTests();
  (globalThis as any).window = globalThis;
  (globalThis as any).event = undefined;
});

test("a write sent while a keydown is handled records the key and target", () => {
  (globalThis as any).event = { type: "keydown", key: "Backspace", ctrlKey: true, shiftKey: true };
  const settle = recordWrite("killSession", ["jx7970z9x5tn8nf06tb8am19218fswbe"], {
    conversations: { jx7970z9x5tn8nf06tb8am19218fswbe: { inbox_dismissed_at: 1 } },
  });
  settle({ ok: true });
  const [e] = getWriteLog();
  expect(e).toMatchObject({ action: "killSession", source: "key", key: "ctrl+shift+Backspace", ok: true });
  expect(e.ids).toEqual(["jx7970z9x5tn8nf06tb8am19218fswbe", "conversations:jx7970z9x5tn8nf06tb8am19218fswbe"]);
  expect(e.stack).toBeUndefined();
});

test("a write with no DOM event is automatic and keeps a stack naming its writer", () => {
  const settle = recordWrite("restartSession", ["c1"], undefined);
  settle({ err: new Error("boom") });
  const [e] = getWriteLog();
  expect(e).toMatchObject({ source: "auto", err: "boom" });
  expect(typeof e.stack).toBe("string");
});

test("a click is recorded as a click", () => {
  (globalThis as any).event = { type: "pointerup" };
  recordWrite("stashSession", ["c2"], undefined);
  expect(getWriteLog()[0].source).toBe("click");
});
