import { test, expect, describe } from "bun:test";
import { createShortcutCatalog, type ShortcutDef } from "./catalog";
import { ShortcutDispatcher, createKeydownHandler } from "./dispatch";

// The non-React dispatch core: handler decline semantics and the keydown
// resolution loop's guards (modal, context, input, key-owning surfaces).

type Action = "next" | "stash" | "zoom" | "listDown" | "terminalToggle";

const DEFS: ShortcutDef<Action>[] = [
  { key: "ctrl+j", action: "next", skipInputCheck: true, description: "Next" },
  { key: "ctrl+backspace", action: "stash", skipInputCheck: "whenEmpty", description: "Stash" },
  { key: "meta+=", action: "zoom", skipInputCheck: true, worksInModal: true, description: "Zoom" },
  { key: "j", action: "listDown", when: "list", description: "Down" },
  { key: "ctrl+`", action: "terminalToggle", skipInputCheck: true, description: "Toggle terminal" },
];

const catalog = createShortcutCatalog(DEFS, { isMac: false });

function makeEvent(over: Partial<{ [K in keyof KeyboardEvent]: unknown }>): KeyboardEvent & { prevented: boolean; stopped: boolean } {
  const e: any = {
    key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: null,
    prevented: false,
    stopped: false,
    preventDefault() { e.prevented = true; },
    stopImmediatePropagation() { e.stopped = true; },
    ...over,
  };
  return e;
}

describe("ShortcutDispatcher", () => {
  test("dispatch with no handlers reports unhandled", () => {
    const d = new ShortcutDispatcher<Action>();
    expect(d.dispatch("next")).toBe(false);
  });

  test("a handler returning false declines and passes to the next", () => {
    const d = new ShortcutDispatcher<Action>();
    const calls: string[] = [];
    d.register("next", () => { calls.push("a"); return false; });
    d.register("next", () => { calls.push("b"); });
    expect(d.dispatch("next")).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  test("a handler returning true handles and stops the walk", () => {
    const d = new ShortcutDispatcher<Action>();
    const calls: string[] = [];
    d.register("next", () => { calls.push("a"); return true; });
    d.register("next", () => { calls.push("b"); });
    expect(d.dispatch("next")).toBe(true);
    expect(calls).toEqual(["a"]);
  });

  test("all handlers declining reports unhandled", () => {
    const d = new ShortcutDispatcher<Action>();
    d.register("next", () => false);
    expect(d.dispatch("next")).toBe(false);
  });

  test("unregister removes exactly the registered handler", () => {
    const d = new ShortcutDispatcher<Action>();
    const off = d.register("next", () => true);
    off();
    expect(d.dispatch("next")).toBe(false);
  });
});

describe("createKeydownHandler", () => {
  function setup(handled: Action[] = ["next", "stash", "zoom", "listDown", "terminalToggle"]) {
    const dispatcher = new ShortcutDispatcher<Action>();
    const fired: Action[] = [];
    for (const a of handled) dispatcher.register(a, () => { fired.push(a); });
    const used: Action[] = [];
    const handler = createKeydownHandler(catalog, dispatcher, {
      inputLikeSelector: "[data-owns-keys]",
      keyboardOwners: [{ selector: "[data-terminal]", allow: ["terminalToggle"] }],
      onShortcutUsed: (a) => used.push(a),
    });
    return { dispatcher, fired, used, handler };
  }

  test("a matching chord dispatches, consumes the event, and reports usage", () => {
    const { fired, used, handler } = setup();
    const e = makeEvent({ key: "j", ctrlKey: true });
    handler(e);
    expect(fired).toEqual(["next"]);
    expect(used).toEqual(["next"]);
    expect(e.prevented).toBe(true);
    expect(e.stopped).toBe(true);
  });

  test("an unhandled action leaves the event alone", () => {
    const { handler } = setup([]);
    const e = makeEvent({ key: "j", ctrlKey: true });
    handler(e);
    expect(e.prevented).toBe(false);
  });

  test("a when-tagged def fires only while its context is active", () => {
    const { dispatcher, fired, handler } = setup();
    const e1 = makeEvent({ key: "j" });
    handler(e1);
    expect(fired).toEqual([]);
    dispatcher.setContext("list", true);
    handler(makeEvent({ key: "j" }));
    expect(fired).toEqual(["listDown"]);
    dispatcher.setContext("list", false);
    handler(makeEvent({ key: "j" }));
    expect(fired).toEqual(["listDown"]);
  });

  test("focus in an input suppresses defs without a bypass", () => {
    const { dispatcher, fired, handler } = setup();
    dispatcher.setContext("list", true);
    const input = { tagName: "TEXTAREA", value: "draft" };
    handler(makeEvent({ key: "j", target: input }));
    expect(fired).toEqual([]); // listDown has no skipInputCheck
    handler(makeEvent({ key: "j", ctrlKey: true, target: input }));
    expect(fired).toEqual(["next"]); // skipInputCheck: true still fires
  });

  test("whenEmpty defers to a full input and fires from an empty one", () => {
    const { fired, handler } = setup();
    handler(makeEvent({ key: "backspace", ctrlKey: true, target: { tagName: "TEXTAREA", value: "text" } }));
    expect(fired).toEqual([]);
    handler(makeEvent({ key: "backspace", ctrlKey: true, target: { tagName: "TEXTAREA", value: "" } }));
    expect(fired).toEqual(["stash"]);
  });

  test("an input-like region suppresses like a real input", () => {
    const { fired, handler } = setup();
    const region = {
      tagName: "DIV",
      closest: (sel: string) => (sel === "[data-owns-keys]" ? {} : null),
    };
    // listDown would need context anyway; use a def without bypass via context.
    const { dispatcher: d2, fired: f2, handler: h2 } = setup();
    d2.setContext("list", true);
    h2(makeEvent({ key: "j", target: region }));
    expect(f2).toEqual([]);
    // A bypassing chord still fires from the region.
    handler(makeEvent({ key: "j", ctrlKey: true, target: region }));
    expect(fired).toEqual(["next"]);
  });

  test("an open modal suppresses everything except worksInModal defs", () => {
    const { fired, handler } = setup();
    (globalThis as any).document = {
      querySelectorAll: () => [{ contains: () => false }],
    };
    try {
      handler(makeEvent({ key: "j", ctrlKey: true }));
      expect(fired).toEqual([]);
      handler(makeEvent({ key: "=", metaKey: true }));
      expect(fired).toEqual(["zoom"]);
    } finally {
      delete (globalThis as any).document;
    }
  });

  test("a keyboard-owning surface lets only its allowed actions through", () => {
    const { fired, handler } = setup();
    const inTerminal = {
      tagName: "DIV",
      closest: (sel: string) => (sel === "[data-terminal]" ? {} : null),
    };
    handler(makeEvent({ key: "j", ctrlKey: true, target: inTerminal }));
    expect(fired).toEqual([]); // ctrl+j belongs to the shell
    handler(makeEvent({ key: "`", ctrlKey: true, target: inTerminal }));
    expect(fired).toEqual(["terminalToggle"]);
  });
});
