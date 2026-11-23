// The sign-in email row in Settings → Accounts (components/settings/SignInEmail):
// Change opens an address field, the address gets a code, and the code moves
// the account (convex/accountEmail.ts). A wrong code is an answer the row
// shows while it stays on the code field; a refusal shows its sentence.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "HTMLInputElement", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
afterAll(() => closeDomWindow(dom.window as any));

const { getFunctionName } = await import("convex/server");
let user: any = { email: "alex@oldco.dev" };
let answer: (name: string, args: any) => any = () => ({});
const calls: Array<[string, any]> = [];
const realUser = { ...(await import("../../hooks/useCurrentUser")) };
mock.module("../../hooks/useCurrentUser", () => ({ ...realUser, useCurrentUser: () => ({ user }) }));
const convex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...convex,
  useMutation: (ref: any) => async (args: any) => { const name = getFunctionName(ref); calls.push([name, args]); return answer(name, args); },
}));

const { SignInEmail } = await import("../settings/SignInEmail");

let root: Root;
const render = (el: any) => act(async () => root.render(el));
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const click = (label: string) => act(async () => { button(label)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
const type = (value: string) => act(async () => {
  const input = document.querySelector("input")!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
});

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  user = { email: "alex@oldco.dev" };
  answer = (name) => (name === "accountEmail:requestEmailChange" ? { sent_to: "alex@newco.dev" } : { changed: true, email: "alex@newco.dev" });
  calls.length = 0;
});
afterEach(async () => { await act(async () => root.unmount()); });

test("Change takes a new address, mails it a code, and the code moves the account", async () => {
  await render(<SignInEmail />);
  expect(text()).toContain("alex@oldco.dev");
  expect(document.querySelector("input")).toBeNull();

  await click("Change");
  await type(" Alex@NewCo.dev ");
  await click("Email me a code");
  expect(calls).toEqual([["accountEmail:requestEmailChange", { email: "Alex@NewCo.dev" }]]);
  // The code step names the address the server says it mailed.
  expect(text()).toContain("Code sent to alex@newco.dev");

  // Letters are dropped and the field stops at six digits.
  await type("12a34567");
  expect(document.querySelector("input")!.value).toBe("123456");
  await click("Confirm");
  expect(calls[1]).toEqual(["accountEmail:confirmEmailChange", { email: "alex@newco.dev", code: "123456" }]);
  // Moved: the flow closes back to the row.
  expect(document.querySelector("input")).toBeNull();
  expect(button("Change")).toBeDefined();
});

test("a wrong code stays on the code field and says so; a new code can be sent", async () => {
  answer = (name) => (name === "accountEmail:requestEmailChange" ? { sent_to: "alex@newco.dev" } : { changed: false, error: "That code is not right" });
  await render(<SignInEmail />);
  await click("Change");
  await type("alex@newco.dev");
  await click("Email me a code");
  await type("000000");
  await click("Confirm");
  expect(text()).toContain("That code is not right");
  expect(text()).toContain("Code sent to alex@newco.dev");

  await click("Send a new code");
  expect(calls.at(-1)).toEqual(["accountEmail:requestEmailChange", { email: "alex@newco.dev" }]);
  // A fresh code clears the field and the old error.
  expect(document.querySelector("input")!.value).toBe("");
  expect(text()).not.toContain("That code is not right");
});

test("a refused address shows the server's sentence and stays on the address field", async () => {
  const { ConvexError } = await import("convex/values");
  answer = () => { throw new ConvexError({ message: "Another account already signs in with that address" }); };
  await render(<SignInEmail />);
  await click("Change");
  await type("taken@newco.dev");
  await click("Email me a code");
  expect(text()).toContain("Another account already signs in with that address");
  expect(text()).not.toContain("Code sent to");

  await click("Cancel");
  expect(document.querySelector("input")).toBeNull();
  expect(text()).not.toContain("Another account");
});

test("an account with no address is offered Add", async () => {
  user = {};
  await render(<SignInEmail />);
  expect(text()).toContain("Not configured");
  expect(button("Add")).toBeDefined();
  expect(button("Change")).toBeUndefined();
});
