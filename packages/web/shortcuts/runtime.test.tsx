import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createKeydownHandler, createShortcutCatalog, ShortcutDispatcher, type ShortcutContextValue } from "@platform/keys";
import { createShortcutRuntime } from "./runtime";

const dom = new JSDOM("<!doctype html><div id='root'></div>");
const globals = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type Action = "palette.toggle" | "session.next" | "session.prev";
const catalog = (paletteKey = "meta+k") => createShortcutCatalog<Action>([
  { key: paletteKey, action: "palette.toggle", skipInputCheck: true, worksInModal: true, description: "Palette" },
  { key: "ctrl+j", action: "session.next", skipInputCheck: true, description: "Next" },
  { key: "ctrl+k", action: "session.prev", skipInputCheck: true, description: "Previous" },
]);

test("refreshed consumers keep registering with an already mounted provider", async () => {
  let runtime = createShortcutRuntime(catalog(), {});
  const MountedProvider = runtime.kit.ShortcutProvider;
  const root = createRoot(document.getElementById("root")!);
  const calls: Action[] = [];
  let context: ShortcutContextValue<Action>;
  function Consumer() {
    const { useShortcutAction, useShortcuts } = runtime.kit;
    context = useShortcuts();
    useShortcutAction("palette.toggle", () => { calls.push("palette.toggle"); });
    useShortcutAction("session.next", () => { calls.push("session.next"); });
    useShortcutAction("session.prev", () => { calls.push("session.prev"); });
    return <input defaultValue="" />;
  }
  await act(async () => { root.render(<MountedProvider><Consumer /></MountedProvider>); });
  const input = document.querySelector("input")!;
  input.value = "unsent draft";

  for (let generation = 0; generation < 4; generation++) {
    runtime = createShortcutRuntime(catalog(), {}, runtime);
    await act(async () => { root.render(<MountedProvider><Consumer /></MountedProvider>); });
    for (const action of ["palette.toggle", "session.next", "session.prev"] as const) {
      expect(context!.dispatchAction(action)).toBe(true);
    }
    expect(calls).toHaveLength((generation + 1) * 3);
    expect(document.querySelector("input")).toBe(input);
    expect(input.value).toBe("unsent draft");
  }
  await act(async () => { root.unmount(); });
  expect(context!.dispatchAction("palette.toggle")).toBe(false);
});

test("an existing listener picks up new bindings and callbacks without replacing the kit", () => {
  const calls: string[] = [];
  const runtime = createShortcutRuntime(catalog(), { onShortcutUsed: () => calls.push("old") });
  const dispatcher = new ShortcutDispatcher<Action>();
  dispatcher.register("palette.toggle", () => true);
  const handle = createKeydownHandler(runtime.catalog, dispatcher, runtime.options);
  const press = (key: string) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
    handle(event as unknown as KeyboardEvent);
    return event.defaultPrevented;
  };
  expect(press("k")).toBe(true);
  const updated = createShortcutRuntime(catalog("meta+p"), { onShortcutUsed: () => calls.push("new") }, runtime);
  expect(updated.kit).toBe(runtime.kit);
  expect(press("k")).toBe(false);
  expect(press("p")).toBe(true);
  expect(calls).toEqual(["old", "new"]);
  createShortcutRuntime(catalog(), {}, runtime);
  expect(press("k")).toBe(true);
  expect(calls).toEqual(["old", "new"]);
});

test("separate runtimes do not share a provider or catalog", () => {
  const first = createShortcutRuntime(catalog(), {});
  const second = createShortcutRuntime(catalog(), {});
  createShortcutRuntime(catalog("meta+p"), {}, first);
  expect(second.kit).not.toBe(first.kit);
  expect(second.catalog.shortcuts[0].key).toBe("meta+k");
});
