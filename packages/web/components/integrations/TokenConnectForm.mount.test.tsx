// Mounts the token connect form in jsdom: the fields come from the
// descriptor's tokenConfig, the token sits in a password field, Connect waits
// for every required setting and the token, an empty defaulted field is left
// for the server to fill, and a stored token is cleared from the field while
// a refused one stays for a retry.
// Run: bun test packages/web/components/integrations/TokenConnectForm.mount.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";
import { APP_DESCRIPTORS } from "@codecast/shared/contracts";
import { closeDomWindow } from "../../test-helpers/domGlobals";

test("token connect form", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { TokenConnectForm } = await import("./TokenConnectForm");

  const submits: { token: string; config: Record<string, string> }[] = [];
  let answer = false;
  let cancelled = 0;
  const root = createRoot(document.getElementById("root")!);
  await act(async () =>
    root.render(
      React.createElement(TokenConnectForm, {
        descriptor: APP_DESCRIPTORS.sentry,
        busy: false,
        onSubmit: async (token: string, config: Record<string, string>) => {
          submits.push({ token, config });
          return answer;
        },
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ),
  );

  const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  const connect = () => document.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const typeInto = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor((dom.window as any).HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new (dom.window as any).Event("input", { bubbles: true }));
    });
  const submit = () =>
    act(async () => {
      document.querySelector("form")!.dispatchEvent(new (dom.window as any).Event("submit", { bubbles: true, cancelable: true }));
    });

  // Org, host, then the token: the token is the only password field.
  const [org, host, token] = inputs();
  assert.equal(inputs().length, 3);
  assert.equal(token.type, "password");
  assert.equal(org.type, "text");
  assert.equal(host.placeholder, "https://sentry.io");
  assert.match(document.body.textContent!, /Auth token/);

  // Nothing filled, or only the token: Connect waits for the required org.
  assert.equal(connect().disabled, true);
  await typeInto(token, "  sntrys_abc  ");
  assert.equal(connect().disabled, true);
  await typeInto(org, " acme ");
  assert.equal(connect().disabled, false);

  // Refused: the trimmed token and settings went up, the empty host stayed
  // out for the server's default, and the token stays for a retry.
  await submit();
  assert.deepEqual(submits, [{ token: "sntrys_abc", config: { org: "acme" } }]);
  assert.equal(token.value, "  sntrys_abc  ");

  // Stored: the token leaves the field.
  answer = true;
  await submit();
  assert.equal(submits.length, 2);
  assert.equal(token.value, "");

  await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Cancel")!.click());
  assert.equal(cancelled, 1);

  await act(async () => root.unmount());
  closeDomWindow(dom);
});
