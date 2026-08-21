import { describe, expect, test } from "bun:test";
import { KeyEngine, parseSpec, isMac, type Binding } from "./engine";

function press(
  engine: KeyEngine,
  key: string,
  opts: Partial<KeyboardEvent> = {},
): boolean {
  const e = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: key.length === 1 && key !== key.toLowerCase(),
    target: null,
    preventDefault() {},
    stopPropagation() {},
    ...opts,
  } as unknown as KeyboardEvent;
  return engine.handle(e);
}

function make(bindings: Partial<Binding>[]): { engine: KeyEngine; fired: string[] } {
  const engine = new KeyEngine();
  const fired: string[] = [];
  engine.register(
    bindings.map(
      (b) =>
        ({
          context: "list",
          group: "t",
          description: b.keys!,
          handler: () => fired.push(b.keys!),
          ...b,
        }) as Binding,
    ),
  );
  engine.setContextSource(() => "list");
  return { engine, fired };
}

describe("parseSpec", () => {
  test("folds shift into printables", () => {
    expect(parseSpec("shift+i")).toEqual(["I"]);
    expect(parseSpec("I")).toEqual(["I"]);
    expect(parseSpec("#")).toEqual(["#"]);
  });
  test("orders modifiers deterministically", () => {
    expect(parseSpec("shift+cmd+enter")).toEqual(["cmd+shift+enter"]);
  });
  test("splits sequences", () => {
    expect(parseSpec("g i")).toEqual(["g", "i"]);
  });
});

describe("KeyEngine", () => {
  test("fires simple bindings", () => {
    const { engine, fired } = make([{ keys: "j" }]);
    expect(press(engine, "j")).toBe(true);
    expect(fired).toEqual(["j"]);
  });

  test("sequences buffer then fire", () => {
    const { engine, fired } = make([{ keys: "g i" }, { keys: "i" }]);
    expect(press(engine, "g")).toBe(true);
    expect(fired).toEqual([]);
    expect(press(engine, "i")).toBe(true);
    expect(fired).toEqual(["g i"]);
  });

  test("dead-end sequences cancel and swallow the key (no accidental command)", () => {
    // After a pending prefix, an unmapped follow key cancels the sequence and
    // is consumed — it must NOT fire as a standalone command ("g" then "e"
    // would otherwise archive; "g" then Escape would exit the view).
    const { engine, fired } = make([{ keys: "g i" }, { keys: "x" }]);
    press(engine, "g");
    expect(press(engine, "x")).toBe(true); // consumed…
    expect(fired).toEqual([]); // …but x did NOT fire
    // The sequence is now clear: x on its own fires normally.
    expect(press(engine, "x")).toBe(true);
    expect(fired).toEqual(["x"]);
  });

  test("shifted printables match explicit specs", () => {
    const { engine, fired } = make([{ keys: "I" }, { keys: "i" }]);
    press(engine, "I");
    expect(fired).toEqual(["I"]);
    press(engine, "i");
    expect(fired).toEqual(["I", "i"]);
  });

  test("context filters bindings", () => {
    const engine = new KeyEngine();
    const fired: string[] = [];
    engine.register([
      {
        keys: "e",
        context: "thread",
        group: "t",
        description: "e",
        handler: () => fired.push("thread-e"),
      },
    ]);
    engine.setContextSource(() => "list");
    expect(press(engine, "e")).toBe(false);
    engine.setContextSource(() => "thread");
    expect(press(engine, "e")).toBe(true);
    expect(fired).toEqual(["thread-e"]);
  });

  test("inputs swallow keys unless allowInInput", () => {
    const { engine, fired } = make([
      { keys: "j" },
      { keys: "cmd+enter", allowInInput: true },
    ]);
    const input = { tagName: "INPUT", isContentEditable: false };
    expect(press(engine, "j", { target: input } as any)).toBe(false);
    expect(
      press(engine, "Enter", { target: input, metaKey: true } as any),
    ).toBe(true);
    expect(fired).toEqual(["cmd+enter"]);
  });

  test("mod chord matches the platform primary modifier", () => {
    // "mod" resolves to cmd on mac / ctrl elsewhere; pressing that primary must
    // match. This is the regression guard for ctrl+d/ctrl+u being dead on
    // Windows/Linux (where the old code folded ctrl into "cmd").
    const { engine, fired } = make([{ keys: "mod+enter" }]);
    const primary = isMac() ? { metaKey: true } : { ctrlKey: true };
    expect(press(engine, "Enter", primary as any)).toBe(true);
    expect(fired).toEqual(["mod+enter"]);
  });

  test("ctrl+d spells to physical ctrl and matches", () => {
    const { engine, fired } = make([{ keys: "ctrl+d" }]);
    expect(press(engine, "d", { ctrlKey: true } as any)).toBe(true);
    expect(fired).toEqual(["ctrl+d"]);
  });

  test("when-guards gate matching", () => {
    let allowed = false;
    const engine = new KeyEngine();
    const fired: string[] = [];
    engine.register([
      {
        keys: "u",
        context: "list",
        group: "t",
        description: "u",
        when: () => allowed,
        handler: () => fired.push("u"),
      },
    ]);
    engine.setContextSource(() => "list");
    expect(press(engine, "u")).toBe(false);
    allowed = true;
    expect(press(engine, "u")).toBe(true);
  });
});
