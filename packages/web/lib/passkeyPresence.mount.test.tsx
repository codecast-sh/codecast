// Touch ID on the web: a gated press confirms with a passkey before the call,
// and once more when the server refuses with the presence code; no passkey
// offers one inline (never in an agent's tab); the desktop app hands the
// ceremony to /confirm in the system browser and waits on the challenge; the
// Approve of an Ask first read asks while Deny answers at once. Against a fake
// Convex client and a mocked navigator.credentials; the prompts' buttons are
// pressed through a mocked sonner.
// Run: cd packages/web && bun test lib/passkeyPresence.mount.test.tsx
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";
import { APPROVE_FOR_SESSION, DENY, NOT_CONFIRMED, presenceRequiredMessage } from "@codecast/shared/contracts/secrets";
import { AGENT_TAB_KEY } from "./desktopHandoff";

// Each prompt answers with its action button unless a test says otherwise.
const toasts: { title: string; opts: any }[] = [];
let promptAnswer: "action" | "cancel" = "action";
const realSonner = await import("sonner");
const fakeToast = Object.assign(
  (title: string, opts: any = {}) => {
    toasts.push({ title, opts });
    if (opts.action && !opts.id) queueMicrotask(() => (promptAnswer === "action" ? opts.action.onClick() : opts.cancel?.onClick()));
    return title;
  },
  { error: (title: string) => void toasts.push({ title: `error:${title}`, opts: {} }), success: () => {}, dismiss: () => {} },
);
mock.module("sonner", () => ({ ...realSonner, toast: fakeToast }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/vault" });
const opened: string[] = [];
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
(dom.window as any).open = (url: string) => void opened.push(url);

const { confirmPresence, withPresence, useApproveGate, deviceName, confirmPath } = await import("./passkeyPresence");
const { ConvexProvider } = await import("convex/react");
const { createRoot } = await import("react-dom/client");
const { useReveal } = await import("../components/secrets/parts");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i + 1)).buffer;

// What a platform authenticator hands back: an assertion for get, an attestation for create.
function credential(kind: "get" | "create") {
  return {
    id: "AQIDBA",
    rawId: bytes(4),
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response:
      kind === "get"
        ? { authenticatorData: bytes(37), clientDataJSON: bytes(20), signature: bytes(64), userHandle: null }
        : { attestationObject: bytes(40), clientDataJSON: bytes(20), getTransports: () => ["internal"] },
  };
}

type Credentials = { get: (o: any) => Promise<any>; create: (o: any) => Promise<any> };
const ceremonies: string[] = [];
function setCredentials(over: Partial<Credentials> = {}) {
  const creds: Credentials = {
    get: async () => (ceremonies.push("get"), credential("get")),
    create: async () => (ceremonies.push("create"), credential("create")),
    ...over,
  };
  Object.defineProperty(dom.window.navigator, "credentials", { value: creds, configurable: true });
}

const AUTH_OPTIONS = { challenge: "Y2hhbGxlbmdl", rpId: "codecast.sh", allowCredentials: [{ id: "AQIDBA", type: "public-key" }], userVerification: "required", timeout: 120000 };
const REG_OPTIONS = {
  challenge: "Y2hhbGxlbmdl",
  rp: { id: "codecast.sh", name: "Codecast" },
  user: { id: "dXNlcg", name: "a@b.c", displayName: "A" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [],
  authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  attestation: "none",
  timeout: 120000,
};

// A Convex client whose actions answer from `answers` by function name and whose challenge watch is driven by `push`.
function fakeClient(answers: Record<string, (args: any) => any>) {
  const calls: { name: string; args: any }[] = [];
  let state: any;
  const listeners = new Set<() => void>();
  return {
    calls,
    push: (next: any) => {
      state = next;
      for (const l of listeners) l();
    },
    action: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      return answers[name]!(args);
    },
    watchQuery: () => ({
      localQueryResult: () => state,
      onUpdate: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    }),
  };
}

const granted = { granted: true, action: "reveal", expires_at: Date.now() + 120_000 };
const begun = { challenge_id: "ch-1", options: AUTH_OPTIONS, expires_at: Date.now() + 120_000 };

beforeEach(() => {
  toasts.length = 0;
  ceremonies.length = 0;
  opened.length = 0;
  promptAnswer = "action";
  sessionStorage.clear();
  setCredentials();
  Object.defineProperty(dom.window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 Safari/537.36", configurable: true });
});

describe("confirmPresence", () => {
  test("asks the platform for an assertion of the challenge and finishes it", async () => {
    const client = fakeClient({ "passkeys:presenceBegin": () => begun, "passkeys:presenceFinish": () => granted });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(true);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin", "passkeys:presenceFinish"]);
    expect(client.calls[0].args).toEqual({ action: "reveal", target: "sec-1", origin: "https://codecast.sh" });
    expect(client.calls[1].args.challenge_id).toBe("ch-1");
    expect(client.calls[1].args.response).toMatchObject({ id: "AQIDBA", type: "public-key", response: { signature: expect.any(String) } });
    expect(ceremonies).toEqual(["get"]);
  });

  test("a cancelled prompt answers false quietly and finishes nothing", async () => {
    setCredentials({ get: async () => Promise.reject(Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" })) });
    const client = fakeClient({ "passkeys:presenceBegin": () => begun, "passkeys:presenceFinish": () => granted });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(false);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin"]);
    expect(toasts.filter((t) => t.title.startsWith("error:"))).toEqual([]);
  });

  test("a refusal from the server is said and answers false", async () => {
    const client = fakeClient({ "passkeys:presenceBegin": () => begun, "passkeys:presenceFinish": () => ({ error: "The passkey could not be verified" }) });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(false);
    expect(toasts.map((t) => t.title)).toContain("error:The passkey could not be verified");
  });

  test("a second press while the prompt is up joins the first", async () => {
    const client = fakeClient({ "passkeys:presenceBegin": () => begun, "passkeys:presenceFinish": () => granted });
    const [a, b] = await Promise.all([confirmPresence(client as any, "approve", "d-1"), confirmPresence(client as any, "approve", "d-1")]);
    expect([a, b]).toEqual([true, true]);
    expect(ceremonies).toEqual(["get"]);
  });

  test("with no passkey yet it sets one up inline, then confirms on a press of its own", async () => {
    let enrolled = false;
    const client = fakeClient({
      "passkeys:presenceBegin": () => (enrolled ? begun : { error: "Set up Touch ID first", needs_passkey: true }),
      "passkeys:registrationBegin": () => ({ challenge_id: "reg-1", options: REG_OPTIONS, expires_at: Date.now() + 120_000 }),
      "passkeys:registrationFinish": () => ((enrolled = true), { id: "pk-1", name: "Chrome on Mac", first: true }),
      "passkeys:presenceFinish": () => granted,
    });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(true);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin", "passkeys:registrationBegin", "passkeys:registrationFinish", "passkeys:presenceBegin", "passkeys:presenceFinish"]);
    expect(client.calls[1].args).toEqual({ origin: "https://codecast.sh" });
    expect(client.calls[2].args.name).toBe("Chrome on Mac");
    expect(ceremonies).toEqual(["create", "get"]);
    expect(toasts.map((t) => t.opts.action?.label)).toEqual(["Set up Touch ID", "Confirm"]);
  });

  test("declining the set-up prompt sends nothing", async () => {
    promptAnswer = "cancel";
    const client = fakeClient({ "passkeys:presenceBegin": () => ({ error: "Set up Touch ID first", needs_passkey: true }) });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(false);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin"]);
    expect(ceremonies).toEqual([]);
  });

  test("an agent's tab is refused a first passkey before anything is asked", async () => {
    sessionStorage.setItem(AGENT_TAB_KEY, "1");
    const client = fakeClient({ "passkeys:presenceBegin": () => ({ error: "Set up Touch ID first", needs_passkey: true }) });
    expect(await confirmPresence(client as any, "reveal", "sec-1")).toBe(false);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin"]);
    expect(ceremonies).toEqual([]);
    expect(toasts.map((t) => t.title)).toEqual(["error:A person sets up Touch ID"]);
  });

  test("the desktop app opens /confirm in the browser and goes on when the challenge is granted", async () => {
    Object.defineProperty(dom.window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh) Codecast/1.1.200 Chrome/140.0 Electron/44.0.0 Safari/537.36", configurable: true });
    const client = fakeClient({ "passkeys:presenceBegin": () => begun });
    const done = confirmPresence(client as any, "approve", "d-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual([`https://codecast.sh${confirmPath("ch-1")}`]);
    expect(toasts.at(-1)?.title).toBe("Confirm in your browser");
    client.push({ purpose: "presence", status: "pending", action: "approve", expires_at: begun.expires_at });
    client.push({ purpose: "presence", status: "granted", action: "approve", expires_at: begun.expires_at });
    expect(await done).toBe(true);
    expect(ceremonies).toEqual([]);
  });

  test("the desktop app's Cancel stops waiting", async () => {
    Object.defineProperty(dom.window.navigator, "userAgent", { value: "Mozilla/5.0 Electron/44.0.0", configurable: true });
    const client = fakeClient({ "passkeys:presenceBegin": () => begun });
    const done = confirmPresence(client as any, "reveal", "sec-2");
    await new Promise((r) => setTimeout(r, 0));
    toasts.at(-1)!.opts.action.onClick({ preventDefault() {} });
    expect(opened).toHaveLength(2);
    toasts.at(-1)!.opts.cancel.onClick();
    expect(await done).toBe(false);
  });
});

describe("withPresence", () => {
  const refusal = { error: presenceRequiredMessage("reveal") };

  test("not confirmed up front, it never calls", async () => {
    let calls = 0;
    expect(await withPresence(async () => false, async () => ++calls, true)).toBe(NOT_CONFIRMED);
    expect(calls).toBe(0);
  });

  test("a presence refusal, answered or thrown, confirms once more and calls again", async () => {
    let confirms = 0;
    const answers = [refusal, { payload: "v" }];
    expect(await withPresence(async () => (++confirms, true), async () => answers.shift(), true)).toEqual({ payload: "v" });
    expect(confirms).toBe(2);
    let thrown = true;
    const call = async () => {
      if (thrown) {
        thrown = false;
        throw new Error(`[CONVEX M(dispatch)] Uncaught Error: ${refusal.error}`);
      }
      return "ok";
    };
    expect(await withPresence(async () => true, call, false)).toBe("ok");
  });

  test("it retries once: a second refusal is the answer", async () => {
    let calls = 0;
    expect(await withPresence(async () => true, async () => (++calls, refusal), true)).toEqual(refusal);
    expect(calls).toBe(2);
  });
});

describe("useApproveGate", () => {
  test("Approve of an Ask first read confirms before it sends; Deny sends at once", async () => {
    const client = fakeClient({ "passkeys:presenceBegin": () => begun, "passkeys:presenceFinish": () => granted });
    const decision = { _id: "d-9", category: "access", options: [{ label: APPROVE_FOR_SESSION }, { label: DENY }] };
    let gate: any;
    function Probe() {
      gate = useApproveGate(decision);
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(() => root.render(<ConvexProvider client={client as any}><Probe /></ConvexProvider>));
    expect([gate.gated(0), gate.gated(1)]).toEqual([true, false]);

    const sent: number[] = [];
    gate.answer(1, () => sent.push(1));
    expect(sent).toEqual([1]);
    expect(client.calls).toEqual([]);

    await gate.answer(0, () => sent.push(0));
    expect(sent).toEqual([1, 0]);
    expect(client.calls.map((c) => c.name)).toEqual(["passkeys:presenceBegin", "passkeys:presenceFinish"]);
    expect(client.calls[0].args.target).toBe("d-9");

    setCredentials({ get: async () => Promise.reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" })) });
    expect(await gate.answer(0, () => sent.push(0))).toBe(NOT_CONFIRMED);
    expect(sent).toEqual([1, 0]);
    await act(() => root.unmount());
  });
});

describe("useReveal of an Ask first secret", () => {
  async function reveal(askFirst: boolean, answers: any[]) {
    const client = fakeClient({
      "passkeys:presenceBegin": () => begun,
      "passkeys:presenceFinish": () => granted,
      "secrets:reveal": () => answers.shift(),
    });
    let hook: any;
    function Probe() {
      hook = useReveal("sec-1", 1, askFirst);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(() => root.render(<ConvexProvider client={client as any}><Probe /></ConvexProvider>));
    let got: any;
    await act(async () => {
      got = await hook.load();
    });
    await act(() => root.unmount());
    return { got, names: client.calls.map((c) => c.name) };
  }

  test("confirms with Touch ID before the value is fetched", async () => {
    const r = await reveal(true, [{ payload: { value: "zz-value" } }]);
    expect(r.names).toEqual(["passkeys:presenceBegin", "passkeys:presenceFinish", "secrets:reveal"]);
    expect(r.got).toEqual({ value: "zz-value" });
  });

  test("a secret switched to Ask first meanwhile is refused, confirmed, and fetched again", async () => {
    const r = await reveal(false, [{ error: presenceRequiredMessage("reveal") }, { payload: { value: "zz-value" } }]);
    expect(r.names).toEqual(["secrets:reveal", "passkeys:presenceBegin", "passkeys:presenceFinish", "secrets:reveal"]);
    expect(r.got).toEqual({ value: "zz-value" });
  });

  test("cancelled, nothing is fetched", async () => {
    setCredentials({ get: async () => Promise.reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" })) });
    const r = await reveal(true, []);
    expect(r.names).toEqual(["passkeys:presenceBegin"]);
    expect(r.got).toBeNull();
  });
});

test("a new passkey is named for the device it was made on", () => {
  expect(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("Safari on Mac");
  expect(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe("Safari on iPhone");
  expect(deviceName("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge on Windows");
  expect(deviceName("")).toBe("Passkey");
});
