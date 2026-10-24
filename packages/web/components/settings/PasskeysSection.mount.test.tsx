// Settings' Touch ID list: each passkey with when it was added and used;
// Remove confirms with Touch ID before the remove call; with no passkey, Add
// sets the first one up at once; in an agent's tab Add is held. Convex is
// faked; navigator.credentials is mocked.
// Run: cd packages/web && bun test components/settings/PasskeysSection.mount.test.tsx
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { AGENT_TAB_KEY } from "../../lib/desktopHandoff";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/settings/accounts" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  PublicKeyCredential: function PublicKeyCredential() {},
  IS_REACT_ACT_ENVIRONMENT: true,
});

let passkeys: any[] | undefined;
const calls: { name: string; args: any }[] = [];
const answer = (name: string, args: any) => {
  calls.push({ name, args });
  if (name === "passkeys:presenceBegin") return { challenge_id: "ch-1", options: { challenge: "Y2g", allowCredentials: [] }, expires_at: Date.now() + 60_000 };
  if (name === "passkeys:registrationBegin") return { challenge_id: "reg-1", options: { challenge: "Y2g", rp: { id: "codecast.sh", name: "Codecast" }, user: { id: "dQ", name: "a", displayName: "a" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] }, expires_at: Date.now() + 60_000 };
  if (name === "passkeys:remove") return { removed: true, id: args.id };
  return { granted: true, id: "pk-new", name: "Passkey", first: true };
};
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, passkeys])),
  useMutation: (ref: any) => async (args: any) => answer(getFunctionName(ref), args),
  useConvex: () => ({ action: async (ref: any, args: any) => answer(getFunctionName(ref), args) }),
}));
const realSonner = await import("sonner");
mock.module("sonner", () => ({ ...realSonner, toast: Object.assign(() => "", { error: () => {}, success: () => {}, dismiss: () => {} }) }));

const { PasskeysSection } = await import("./PasskeysSection");
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const buf = (n: number) => new Uint8Array(n).fill(3).buffer;
const ceremonies: string[] = [];
Object.defineProperty(dom.window.navigator, "credentials", {
  configurable: true,
  value: {
    get: async () => (ceremonies.push("get"), { id: "AQ", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}), response: { authenticatorData: buf(37), clientDataJSON: buf(9), signature: buf(64), userHandle: null } }),
    create: async () => (ceremonies.push("create"), { id: "AQ", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}), response: { attestationObject: buf(30), clientDataJSON: buf(9), getTransports: () => ["internal"] } }),
  },
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<PasskeysSection />));
  return { container, unmount: () => act(() => root.unmount()) };
}
const click = (el: Element | null) => act(async () => {
  (el as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  calls.length = 0;
  ceremonies.length = 0;
  sessionStorage.clear();
});

describe("PasskeysSection", () => {
  test("lists each passkey; Remove asks for Touch ID, then removes it", async () => {
    passkeys = [{ _id: "pk-1", name: "Chrome on Mac", created_at: Date.now() - 3 * 86_400_000, last_used_at: Date.now() - 60_000 }];
    const m = await mount();
    const row = m.container.querySelector("[data-passkey='pk-1']")!;
    expect(row.querySelector("[data-passkey-name]")!.textContent).toBe("Chrome on Mac");
    expect(row.textContent).toContain("added 3d ago");
    await click(row.querySelector("[data-passkey-remove]"));
    expect(calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin", "passkeys:presenceFinish", "passkeys:remove"]);
    expect(calls[0].args).toMatchObject({ action: "remove_passkey", target: "pk-1" });
    expect(ceremonies).toEqual(["get"]);
    await m.unmount();
  });

  test("with none, Add sets up the first passkey with no Touch ID to assert", async () => {
    passkeys = [];
    const m = await mount();
    expect(m.container.querySelector("[data-passkeys-empty]")).not.toBeNull();
    await click(m.container.querySelector("[data-passkey-add]"));
    expect(calls.map((c) => c.name)).toEqual(["passkeys:registrationBegin", "passkeys:registrationFinish"]);
    expect(ceremonies).toEqual(["create"]);
    await m.unmount();
  });

  test("in an agent's tab, Add is held", async () => {
    sessionStorage.setItem(AGENT_TAB_KEY, "1");
    passkeys = [];
    const m = await mount();
    const add = m.container.querySelector("[data-passkey-add]") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe("A person sets up Touch ID");
    await m.unmount();
  });
});
