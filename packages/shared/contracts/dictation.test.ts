import { afterEach, describe, expect, test } from "bun:test";

import {
  DICTATION_MAX_MS,
  DICTATION_SILENCE_MS,
  _resetDictationForTests,
  createDictation,
  dictationAnchor,
  dictationLanguageLabel,
  dictationLanguages,
  spliceDictation,
  spokenText,
  type DictationPipe,
  type DictationPipeEvents,
  type DictationState,
} from "./dictation";

afterEach(() => _resetDictationForTests());

describe("spliceDictation", () => {
  const at = (value: string, start: number, end = start) => dictationAnchor(value, [start, end]);

  test("an empty box takes the words as they are", () => {
    expect(spliceDictation(at("", 0), "hello there")).toEqual({ value: "hello there", caret: 11 });
  });

  test("a space goes between existing text and the words, and after them before more text", () => {
    expect(spliceDictation(at("fix the", 7), "auth bug")).toEqual({ value: "fix the auth bug", caret: 16 });
    expect(spliceDictation(at("fix  please", 4), "the bug")).toEqual({ value: "fix the bug please", caret: 11 });
  });

  test("no doubled space, and none before punctuation", () => {
    expect(spliceDictation(at("fix ", 4), "it")).toEqual({ value: "fix it", caret: 6 });
    expect(spliceDictation(at("fix .", 4), "it")).toEqual({ value: "fix it.", caret: 6 });
  });

  test("a selection is replaced", () => {
    expect(spliceDictation(at("use OLD here", 4, 7), "new")).toEqual({ value: "use new here", caret: 7 });
  });

  test("nothing heard leaves the text around the anchor untouched", () => {
    expect(spliceDictation(at("use OLD here", 4, 7), "")).toEqual({ value: "use  here", caret: 4 });
  });

  test("no selection means the end of the text", () => {
    expect(dictationAnchor("abc", null)).toMatchObject({ before: "abc", after: "", selection: [3, 3] });
  });

  test("Japanese joins without spaces", () => {
    expect(spokenText(["こんにちは"], "世界")).toBe("こんにちは世界");
    expect(spliceDictation(at("日本", 2), "語")).toEqual({ value: "日本語", caret: 3 });
  });

  test("spoken text collapses whitespace and joins sentences with one space", () => {
    expect(spokenText(["  Hello  world. ", "Second"], " third ")).toBe("Hello world. Second third");
    expect(spokenText([], "")).toBe("");
  });
});

describe("languages", () => {
  test("a chosen language is the whole allowlist; Auto is the device's", () => {
    expect(dictationLanguages("ja")).toEqual(["ja"]);
    expect(Array.isArray(dictationLanguages(null))).toBe(true);
    expect(dictationLanguageLabel("ja")).toBe("Japanese");
    expect(dictationLanguageLabel(null)).toBe("Auto");
    expect(dictationLanguageLabel("xx")).toBe("Auto");
  });
});

// ── The controller, against a fake field, recognizer and clock ────────────

function harness(initial = "", selection: [number, number] | null = null) {
  let value = initial;
  let sel = selection;
  const states: DictationState[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  let nextTimer = 1;
  let events: DictationPipeEvents | null = null;
  let resolveOpen: ((p: DictationPipe) => void) | null = null;
  let rejectOpen: ((e: Error) => void) | null = null;
  let resolveFinish: (() => void) | null = null;
  const pipe = {
    finished: 0,
    closed: 0,
    finish() {
      pipe.finished++;
      return new Promise<void>((r) => (resolveFinish = r));
    },
    close() {
      pipe.closed++;
    },
  };
  const field = {
    getValue: () => value,
    getSelection: () => sel,
    setValue(v: string, caret: number, anchor?: number) {
      value = v;
      sel = [anchor ?? caret, caret];
    },
  };
  const d = createDictation(
    field,
    {
      open(e) {
        events = e;
        return new Promise((res, rej) => {
          resolveOpen = res;
          rejectOpen = rej;
        });
      },
      setTimer(fn, ms) {
        const id = nextTimer++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer(h) {
        timers.delete(h as number);
      },
    },
    (s) => states.push(s),
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    d,
    pipe,
    states,
    get value() {
      return value;
    },
    get selection() {
      return sel;
    },
    type(v: string) {
      value = v;
    },
    get events() {
      if (!events) throw new Error("not opened");
      return events;
    },
    async opened() {
      resolveOpen!(pipe);
      await flush();
    },
    async refused(message: string) {
      rejectOpen!(new Error(message));
      await flush();
    },
    async finished() {
      resolveFinish!();
      await flush();
      await flush();
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("createDictation", () => {
  test("starting, listening, words streaming in place, then Finish keeps them", async () => {
    const h = harness("Please ", [7, 7]);
    h.d.start();
    expect(h.d.state.phase).toBe("starting");
    await h.opened();
    expect(h.d.state.phase).toBe("listening");
    h.events.onPartial("fix");
    expect(h.value).toBe("Please fix");
    h.events.onPartial("fix the bug");
    expect(h.value).toBe("Please fix the bug");
    h.events.onUtterance({ text: "Fix the bug." });
    expect(h.value).toBe("Please Fix the bug.");
    h.events.onPartial("thanks");
    expect(h.value).toBe("Please Fix the bug. thanks");
    const done = h.d.finish();
    expect(h.d.state.phase).toBe("finishing");
    h.events.onUtterance({ text: "Thanks." });
    await h.finished();
    await done;
    expect(h.value).toBe("Please Fix the bug. Thanks.");
    expect(h.selection).toEqual([27, 27]);
    expect(h.d.state).toEqual({ phase: "idle", error: null, stopped: null });
    expect(h.pipe.closed).toBe(1);
  });

  test("a sentence the recognizer never closed stays after Finish", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    h.events.onPartial("half a thought");
    const done = h.d.finish();
    await h.finished();
    await done;
    expect(h.value).toBe("half a thought");
  });

  test("Cancel puts the box back exactly, selection included", async () => {
    const h = harness("keep OLD this", [5, 8]);
    h.d.start();
    await h.opened();
    h.events.onUtterance({ text: "new words" });
    expect(h.value).toBe("keep new words this");
    h.d.cancel();
    expect(h.value).toBe("keep OLD this");
    expect(h.selection).toEqual([5, 8]);
    expect(h.d.state.phase).toBe("idle");
    expect(h.pipe.closed).toBe(1);
    // A late word from the abandoned recognizer changes nothing.
    h.events.onUtterance({ text: "late" });
    expect(h.value).toBe("keep OLD this");
  });

  test("Cancel while the microphone is still opening closes it when it arrives", async () => {
    const h = harness("x");
    h.d.start();
    h.d.cancel();
    await h.opened();
    expect(h.pipe.closed).toBe(1);
    expect(h.d.state.phase).toBe("idle");
    expect(h.value).toBe("x");
  });

  test("a blocked microphone reports why and changes nothing", async () => {
    const h = harness("draft");
    h.d.start();
    await h.refused("Microphone blocked");
    expect(h.d.state).toEqual({ phase: "idle", error: "Microphone blocked", stopped: null });
    expect(h.value).toBe("draft");
  });

  test("a refused server key reports its line", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    h.events.onFailed("AI features are off for Acme: no BAA with OpenAI yet.");
    expect(h.d.state.error).toBe("AI features are off for Acme: no BAA with OpenAI yet.");
    expect(h.d.state.phase).toBe("idle");
  });

  test("a minute without new words stops it and keeps the words", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    h.advance(DICTATION_SILENCE_MS - 1000);
    h.events.onUtterance({ text: "one" });
    h.advance(DICTATION_SILENCE_MS - 1000);
    expect(h.d.state.phase).toBe("listening");
    h.advance(1000);
    expect(h.d.state.phase).toBe("finishing");
    await h.finished();
    expect(h.d.state).toEqual({ phase: "idle", error: null, stopped: "silence" });
    expect(h.value).toBe("one");
  });

  test("ten minutes is the limit however much is said", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    for (let t = 0; t < DICTATION_MAX_MS; t += 30_000) {
      h.events.onUtterance({ text: "w" });
      h.advance(30_000);
    }
    await h.finished();
    expect(h.d.state.stopped).toBe("limit");
  });

  test("a dropped connection finishes with the words kept", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    h.events.onPartial("so far");
    h.events.onDropped();
    await h.finished();
    expect(h.d.state.stopped).toBe("dropped");
    expect(h.value).toBe("so far");
  });

  test("typing into the box mid-recording stops it and keeps the typing", async () => {
    const h = harness();
    h.d.start();
    await h.opened();
    h.events.onPartial("hello");
    h.type("hello, typed");
    h.events.onPartial("hello world");
    expect(h.value).toBe("hello, typed");
    expect(h.d.state.stopped).toBe("edited");
    expect(h.pipe.closed).toBe(1);
  });

  test("starting a second recording finishes the first", async () => {
    const a = harness();
    const b = harness();
    a.d.start();
    await a.opened();
    b.d.start();
    expect(a.d.state.phase).toBe("finishing");
    expect(b.d.state.phase).toBe("starting");
    // The second opens the microphone only after the first has let go.
    expect(() => b.events).toThrow();
    await a.finished();
    expect(a.d.state.phase).toBe("idle");
    expect(b.events).toBeTruthy();
    await b.opened();
    expect(b.d.state.phase).toBe("listening");
  });

  test("cancelling a start that waits on the previous recording never opens the microphone", async () => {
    const a = harness();
    const b = harness();
    a.d.start();
    await a.opened();
    b.d.start();
    b.d.cancel();
    await a.finished();
    expect(() => b.events).toThrow();
    expect(b.d.state.phase).toBe("idle");
  });

  test("Finish before any words leaves the box as it was", async () => {
    const h = harness("draft");
    h.d.start();
    await h.opened();
    const done = h.d.finish();
    await h.finished();
    await done;
    expect(h.value).toBe("draft");
  });
});

describe("finishRunningDictation", () => {
  test("finishes whatever recording is running, and is a no-op when none is", async () => {
    const { finishRunningDictation, dictationRunning } = await import("./dictation");
    await finishRunningDictation();
    const h = harness();
    h.d.start();
    await h.opened();
    expect(dictationRunning()).toBe(true);
    h.events.onPartial("words");
    const done = finishRunningDictation();
    expect(h.d.state.phase).toBe("finishing");
    await h.finished();
    await done;
    expect(dictationRunning()).toBe(false);
    expect(h.value).toBe("words");
  });
});
