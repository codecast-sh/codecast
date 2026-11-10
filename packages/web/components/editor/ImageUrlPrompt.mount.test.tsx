// The Image slash command's URL form: a typed URL is handed on, an empty
// submit or Escape cancels. Run: bun test components/editor/ImageUrlPrompt.mount.test.tsx
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

let dom: any;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
    (globalThis as Record<string, unknown>)[key] = dom.window[key];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
}, 120_000);

afterAll(() => closeDomWindow(dom));

async function mount() {
  const { ImageUrlForm } = await import("./ImageUrlPrompt");
  const calls: string[] = [];
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(ImageUrlForm, { onSubmit: (u: string) => calls.push(`submit:${u}`), onCancel: () => calls.push("cancel") }));
  });
  const form = host.querySelector("form[data-image-url-form]") as HTMLFormElement;
  const input = host.querySelector("input") as HTMLInputElement;
  const type = async (value: string) => {
    const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = () => act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  return { calls, form, input, type, submit };
}

test("a typed URL is handed on, trimmed", async () => {
  const m = await mount();
  await m.type("  https://example.com/a.png ");
  await m.submit();
  expect(m.calls).toEqual(["submit:https://example.com/a.png"]);
});

test("an empty submit and Escape both cancel", async () => {
  const m = await mount();
  await m.submit();
  await act(async () => { m.input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(m.calls).toEqual(["cancel", "cancel"]);
});
