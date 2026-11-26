// ct-101961: moving the mouse froze the inbox for ~1.5s. The replay recorder
// sleeps rrweb after DOM_IDLE_MS without input, and its document-level
// pointermove/focusin handler (noteInput) woke it synchronously: domWake calls
// rrweb's record(), which walks and serializes the whole page (a full
// snapshot) inside the event handler. An input handler must only stamp the
// time; the restart has to happen once, after the event, off the input path.
//
// Lives outside platform/ because platform/packages is a generated mirror;
// the fix (and this test beside replay.test.ts) belongs in canonical
// @platform/analytics. Run with: bash tests/replay-wake/run.sh
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Window } from "../../platform/packages/analytics/node_modules/happy-dom";
import { startReplay, DOM_IDLE_MS, type DomEvent, type ReplayRecorder, type StartDomRecording } from "../../platform/packages/analytics/src/replay";
import type { CodecastErrorItem, CodecastSink } from "../../platform/packages/analytics/src/codecast";

let win: Window;
let recorder: ReplayRecorder | null = null;
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "history", "location", "XMLHttpRequest", "CSS"] as const;
let clock = 0;
const timers: Array<{ fn: () => void; ms: number; ran?: boolean }> = [];

function sink(): CodecastSink {
  const listeners = new Set<(item: CodecastErrorItem) => void>();
  return {
    endpoint: "https://ingest.test/cli/ingest",
    ingestKey: "cc_ing_x",
    stopped: false,
    pending: 0,
    onError: (fn: (item: CodecastErrorItem) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    setReplayId: () => {},
    scrubUrl: (t: string) => t,
    replay: () => {},
    signReplayChunk: async () => null,
    captureError: () => {},
  } as unknown as CodecastSink;
}

// A stand-in for rrweb that counts how often record() (a full page walk) runs.
function fakeDom() {
  const state = { starts: 0, running: false };
  let ts = 0;
  const load = async (): Promise<StartDomRecording> => (emit: (e: DomEvent, c: boolean) => void) => {
    state.starts++;
    state.running = true;
    emit({ type: 4, timestamp: ++ts, data: { href: "https://app.test/", width: 800, height: 600 } }, false);
    emit({ type: 2, timestamp: ++ts, data: { node: {} } }, false);
    return { checkout: () => {}, stop: () => void (state.running = false) };
  };
  return { load, state };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(() => {
  win = new Window({ url: "https://app.test/inbox" });
  for (const k of GLOBALS) {
    saved[k] = (globalThis as any)[k];
    (globalThis as any)[k] = k === "window" ? win : (win as any)[k];
  }
  clock = 1_000;
  timers.length = 0;
  win.document.body.innerHTML = `<main><p>a long conversation</p></main>`;
});

afterEach(() => {
  recorder?.stop();
  recorder = null;
  for (const k of GLOBALS) (globalThis as any)[k] = saved[k];
  win.close();
});

describe("waking the DOM recorder after an idle sleep (ct-101961)", () => {
  for (const type of ["pointermove", "pointerdown", "wheel", "touchstart", "focusin"]) {
    it(`a ${type} after the sleep does not snapshot the page inside the handler; it restarts once, afterwards`, async () => {
      const dom = fakeDom();
      recorder = startReplay({
        sink: sink(),
        now: () => clock,
        random: () => 0.5,
        replayDom: "onError",
        loadDomRecorder: dom.load,
        setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
        clearTimeout: (id) => {
          const t = timers[(id as number) - 1];
          if (t) t.ran = true;
        },
      });
      await until(() => dom.state.starts === 1);
      expect(dom.state.starts).toBe(1);

      // Nobody touches the page for DOM_IDLE_MS: the idle timer puts rrweb to sleep.
      clock += DOM_IDLE_MS;
      const idle = timers.filter((t) => !t.ran && t.ms >= 1_000 && t.ms <= DOM_IDLE_MS).at(-1)!;
      idle.ran = true;
      idle.fn();
      expect(dom.state.running).toBe(false);

      // The person moves the mouse: a burst of events. None may start rrweb
      // (a full snapshot) while the event is being dispatched.
      const pending = timers.length;
      for (let i = 0; i < 5; i++) {
        win.document.dispatchEvent(new win.Event(type) as unknown as Event);
        clock += 16;
      }
      expect(dom.state.starts).toBe(1);

      // After the events, the recorder does restart, exactly once.
      for (let i = 0; i < 100 && dom.state.starts === 1; i++) {
        for (const t of timers.slice(pending)) {
          if (t.ran) continue;
          t.ran = true;
          clock += t.ms;
          t.fn();
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(dom.state.starts).toBe(2);
      expect(dom.state.running).toBe(true);
    });
  }
});
