// Putting an account in a team's pool: the success toast is the answer to the
// server accepting the share. When the server refuses it ("You can only share
// an account with a team you are on"), no toast may be left saying the account
// is in the team's pool (ct-101555).
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/settings/accounts", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "CustomEvent", "FocusEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle", "NodeFilter", "DocumentFragment", "HTMLButtonElement", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
// Radix's dialog reaches for DOM constructors (HTMLInputElement, NodeFilter, …)
// as globals: take every one jsdom has that bun does not.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (/^[A-Z]/.test(key) && !(key in globalThis)) Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Toasts still standing, by id: a success counts until it is dismissed or
// replaced by a toast that is not a success under the same id.
let standing = new Map<string | number, { kind: string; text: string }>();
let nextId = 0;
const show = (kind: string) => (text: unknown, opts?: { id?: string | number }) => {
  const id = opts?.id ?? ++nextId;
  standing.set(id, { kind, text: String(text) });
  return id;
};
const toast: any = Object.assign(show("default"), {
  success: show("success"),
  error: show("error"),
  info: show("info"),
  warning: show("warning"),
  message: show("default"),
  loading: show("loading"),
  dismiss: (id?: string | number) => { if (id === undefined) standing.clear(); else standing.delete(id); },
  promise: (p: Promise<unknown> | (() => Promise<unknown>), o: any = {}) => {
    const id = o.id ?? ++nextId;
    if (o.loading) standing.set(id, { kind: "loading", text: String(o.loading) });
    const run = typeof p === "function" ? p() : p;
    Promise.resolve(run).then(
      (v) => { const t = typeof o.success === "function" ? o.success(v) : o.success; if (t) standing.set(id, { kind: "success", text: String(t) }); else standing.delete(id); },
      (e) => { const t = typeof o.error === "function" ? o.error(e) : o.error; if (t) standing.set(id, { kind: "error", text: String(t) }); else standing.delete(id); },
    );
    return id;
  },
});
mock.module("sonner", () => ({ toast, Toaster: () => null }));

const { AccountPoolPill } = await import("../AccountPoolPill");
const { useInboxStore } = await import("../../../store/inboxStore");

const TEAM = { _id: "team_society", name: "Society Library" };
let root: Root;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  standing = new Map();
});
afterEach(async () => {
  await act(async () => root.unmount());
  (useInboxStore.getState() as any)._setDispatch(null);
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

test("a share the server refuses leaves no toast saying the account is in the pool", async () => {
  const sent: string[] = [];
  (useInboxStore.getState() as any)._setDispatch((action: string) => {
    sent.push(action);
    return action === "setAccountShares"
      ? Promise.reject(new Error("Uncaught Error: You can only share an account with a team you are on"))
      : Promise.resolve(undefined);
  });
  await act(async () => {
    useInboxStore.setState({ currentUser: { _id: "u1", name: "Ada" }, teams: [TEAM], accountPool: {} } as any);
  });
  await act(async () => root.render(<AccountPoolPill deviceId="laptop" email="ada@example.com" />));

  const pill = document.querySelector("button[aria-pressed]") as HTMLButtonElement;
  expect(pill.title).toBe("Share with Society Library");
  await act(async () => { pill.click(); });
  const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Share with Society Library");
  expect(confirm).toBeTruthy();
  await act(async () => { confirm!.click(); });
  await settle();

  // The share went to the server and came back refused.
  expect(sent).toContain("setAccountShares");
  const successes = [...standing.values()].filter((t) => t.kind === "success").map((t) => t.text);
  expect(successes).toEqual([]);
});
