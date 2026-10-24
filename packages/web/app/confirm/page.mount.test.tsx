// /confirm, where the desktop app and the phone send a Touch ID confirmation:
// with no codecast session it reads the challenge by id, runs the passkey
// ceremony the challenge asks for (an assertion, or a first passkey) and
// finishes it; a used or expired challenge says so; an agent's tab gets a
// disabled control. Convex is faked; navigator.credentials is mocked.
// Run: cd packages/web && bun test app/confirm/page.mount.test.tsx
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { AGENT_TAB_KEY } from "../../lib/desktopHandoff";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/confirm?c=ch-7" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  PublicKeyCredential: function PublicKeyCredential() {},
  IS_REACT_ACT_ENVIRONMENT: true,
});

let challenge: any;
const actions: { name: string; args: any }[] = [];
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useQueries: (queries: Record<string, unknown>) => Object.fromEntries(Object.keys(queries).map((k) => [k, challenge])),
  useConvex: () => ({
    action: async (ref: any, args: any) => {
      actions.push({ name: getFunctionName(ref), args });
      return { granted: true };
    },
  }),
}));
mock.module("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
const realSonner = await import("sonner");
mock.module("sonner", () => ({ ...realSonner, toast: Object.assign(() => "", { error: () => {}, success: () => {}, dismiss: () => {} }) }));

const { default: ConfirmPage } = await import("./page");
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const buf = (n: number) => new Uint8Array(n).fill(7).buffer;
const ceremonies: string[] = [];
Object.defineProperty(dom.window.navigator, "credentials", {
  configurable: true,
  value: {
    get: async () => (ceremonies.push("get"), { id: "AQ", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}), response: { authenticatorData: buf(37), clientDataJSON: buf(9), signature: buf(64), userHandle: null } }),
    create: async () => (ceremonies.push("create"), { id: "AQ", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}), response: { attestationObject: buf(30), clientDataJSON: buf(9), getTransports: () => ["internal"] } }),
  },
});

const PENDING = { purpose: "presence", status: "pending", action: "approve", label: "Let jx7 read STRIPE_KEY?", expires_at: Date.now() + 60_000, options: { challenge: "Y2g", rpId: "codecast.sh", allowCredentials: [], userVerification: "required" } };

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<ConfirmPage />));
  return { container, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  actions.length = 0;
  ceremonies.length = 0;
  sessionStorage.clear();
});

describe("/confirm", () => {
  test("a pending presence challenge confirms with an assertion, signed out", async () => {
    challenge = PENDING;
    const m = await mount();
    expect(m.container.querySelector("h1")!.textContent).toBe("Confirm to approve an Ask first read");
    expect(m.container.querySelector("[data-confirm-sub]")!.textContent).toBe(PENDING.label);
    await act(async () => (m.container.querySelector("[data-confirm-run]") as HTMLButtonElement).click());
    expect(ceremonies).toEqual(["get"]);
    expect(actions.map((a) => a.name)).toEqual(["passkeys:presenceFinish"]);
    expect(actions[0].args.challenge_id).toBe("ch-7");
    await m.unmount();
  });

  test("an enrollment challenge creates the passkey and stores it", async () => {
    challenge = { ...PENDING, purpose: "register", action: undefined, label: undefined, options: { challenge: "Y2g", rp: { id: "codecast.sh", name: "Codecast" }, user: { id: "dQ", name: "a", displayName: "a" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] } };
    const m = await mount();
    expect(m.container.querySelector("h1")!.textContent).toBe("Set up Touch ID");
    await act(async () => (m.container.querySelector("[data-confirm-run]") as HTMLButtonElement).click());
    expect(ceremonies).toEqual(["create"]);
    expect(actions.map((a) => a.name)).toEqual(["passkeys:registrationFinish"]);
    await m.unmount();
  });

  test("granted, used and expired challenges say where things stand", async () => {
    for (const [state, title] of [["granted", "Confirmed"], ["used", "Confirmed"], ["expired", "This confirmation expired"]] as const) {
      challenge = { purpose: "presence", status: state, action: "reveal", expires_at: 0 };
      const m = await mount();
      expect(m.container.querySelector("h1")!.textContent).toBe(title);
      expect(m.container.querySelector("[data-confirm-run]")).toBeNull();
      await m.unmount();
    }
    challenge = null;
    const m = await mount();
    expect(m.container.querySelector("h1")!.textContent).toBe("Nothing to confirm");
    await m.unmount();
  });

  test("an agent's tab gets a disabled control and runs no ceremony", async () => {
    sessionStorage.setItem(AGENT_TAB_KEY, "1");
    challenge = PENDING;
    const m = await mount();
    const run = m.container.querySelector("[data-confirm-run]") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.textContent).toBe("A person confirms this");
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" })));
    expect(ceremonies).toEqual([]);
    await m.unmount();
  });
});
