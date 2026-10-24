// In a tab the cast browser drives (the agent-tab stamp), an Ask first
// secret's reveal and copy, the Approve of its read, and turning Ask first
// off are disabled and say a person does them; in a person's tab every one
// works, an Approve after Touch ID. Run: cd packages/web && bun test lib/agentTabGuard.mount.test.tsx
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";
import { APPROVE_FOR_SESSION, DENY } from "@codecast/shared/contracts/secrets";
import { getFunctionName } from "convex/server";
import { ConvexProvider } from "convex/react";
import { AGENT_TAB_EVENT, AGENT_TAB_KEY } from "./desktopHandoff";
import { PERSON_ONLY, heldOption, useAgentDrivenTab } from "./agentTabGuard";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/settings/vault" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { DecisionAnswerControls } = await import("../components/decisions/DecisionAnswerControls");
const { MaskedField } = await import("../components/secrets/parts");
const { AskFirst } = await import("../components/secrets/SecretDetail");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });
beforeEach(() => sessionStorage.clear());

const stamp = () => sessionStorage.setItem(AGENT_TAB_KEY, "1");

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

const approval = { category: "access", options: [{ label: APPROVE_FOR_SESSION }, { label: DENY }] };

describe("heldOption", () => {
  test("holds only an Ask first approval's Approve, and only in an agent's tab", () => {
    expect(heldOption(approval, 0, true)).toBe(PERSON_ONLY.approve);
    expect(heldOption(approval, 1, true)).toBeUndefined();
    expect(heldOption(approval, 0, false)).toBeUndefined();
    expect(heldOption({ ...approval, category: "product" }, 0, true)).toBeUndefined();
  });
});

describe("useAgentDrivenTab", () => {
  test("reads the stamp, and a driver that stamps late flips a mounted control", async () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useAgentDrivenTab());
      return null;
    }
    const { unmount } = await mount(<Probe />);
    expect(seen.at(-1)).toBe(false);
    await act(() => {
      stamp();
      document.dispatchEvent(new Event(AGENT_TAB_EVENT));
    });
    expect(seen.at(-1)).toBe(true);
    unmount();
  });
});

describe("an Ask first decision card", () => {
  const decision: any = { _id: "d-zz-approval", ...approval, kind: "single", status: "pending", blocking: true };
  const rows = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-option]")) as HTMLButtonElement[];

  test("in an agent's tab, Approve is disabled and says a person approves; Deny and its digit still answer", async () => {
    stamp();
    const answers: any[] = [];
    const { container, unmount } = await mount(<DecisionAnswerControls decision={decision} onAnswer={(a) => answers.push(a)} keys size="compact" />);
    const [approve, deny] = rows(container);
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe(PERSON_ONLY.approve);
    expect(approve.querySelector("[data-held]")!.textContent).toBe(PERSON_ONLY.approve);
    await act(() => { approve.click(); });
    await act(() => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "1" })); });
    expect(answers).toEqual([]);
    await act(() => { deny.click(); });
    expect(answers).toEqual([{ index: 1 }]);
    unmount();
  }, 30_000); // the first mount pays for loading the store under a loaded machine

  test("in a person's tab, Approve carries a fingerprint and answers once Touch ID confirms it", async () => {
    // A passkey assertion against a fake Convex client (lib/passkeyPresence.mount.test.tsx covers the ceremony).
    const buf = (n: number) => new Uint8Array(n).buffer;
    const calls: string[] = [];
    const client = {
      action: async (ref: any) => {
        const name = getFunctionName(ref);
        calls.push(name);
        return name === "passkeys:presenceBegin" ? { challenge_id: "ch-zz", options: { challenge: "Y2g", allowCredentials: [] }, expires_at: Date.now() + 60_000, grant: "ch-zz.g" } : { granted: true };
      },
    };
    const restore = replaceGlobals({ PublicKeyCredential: function PublicKeyCredential() {} });
    Object.defineProperty(dom.window.navigator, "credentials", {
      configurable: true,
      value: { get: async () => ({ id: "AQ", rawId: buf(1), type: "public-key", getClientExtensionResults: () => ({}), response: { authenticatorData: buf(37), clientDataJSON: buf(9), signature: buf(64), userHandle: null } }) },
    });
    const answers: any[] = [];
    const { container, unmount } = await mount(
      <ConvexProvider client={client as any}>
        <DecisionAnswerControls decision={decision} onAnswer={(a) => answers.push(a)} size="compact" />
      </ConvexProvider>,
    );
    const [approve, deny] = rows(container);
    expect(approve.disabled).toBe(false);
    expect(approve.querySelector("[data-held]")).toBeNull();
    expect([!!approve.querySelector("[data-gated]"), !!deny.querySelector("[data-gated]")]).toEqual([true, false]);
    await act(async () => { approve.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(calls).toEqual(["passkeys:presenceBegin", "passkeys:presenceFinish"]);
    expect(answers).toEqual([{ index: 0, presence: "ch-zz.g" }]);
    unmount();
    restore();
  });
});

describe("an Ask first secret's value", () => {
  async function mountField(held?: string) {
    let loads = 0;
    const load = async () => (loads++, undefined);
    const m = await mount(<MaskedField label="Value" value={undefined} load={load} held={held} />);
    const reveal = m.container.querySelector("[data-vault-reveal]") as HTMLButtonElement;
    const copy = m.container.querySelector("[data-vault-copy]") as HTMLButtonElement;
    return { ...m, reveal, copy, loads: () => loads };
  }

  test("held: reveal and copy are disabled, say a person reveals it, and fetch nothing", async () => {
    const m = await mountField(PERSON_ONLY.reveal);
    expect([m.reveal.disabled, m.copy.disabled]).toEqual([true, true]);
    expect([m.reveal.title, m.copy.title]).toEqual([PERSON_ONLY.reveal, PERSON_ONLY.reveal]);
    await act(async () => { m.reveal.click(); m.copy.click(); });
    expect(m.loads()).toBe(0);
    m.unmount();
  });

  test("not held: reveal fetches the value", async () => {
    const m = await mountField();
    expect([m.reveal.disabled, m.copy.disabled]).toEqual([false, false]);
    await act(async () => { m.reveal.click(); });
    expect(m.loads()).toBe(1);
    m.unmount();
  });
});

describe("the Ask first switch", () => {
  const row: any = { _id: "s-zz", short_id: "sec-zz", name: "zz-guard", kind: "key", workspace: "user:u1", status: "ready", created_at: 0, updated_at: 0 };
  const sw = (c: HTMLElement) => c.querySelector("[role=switch]") as HTMLButtonElement;

  test("in an agent's tab, on cannot be turned off, and says a person does it", async () => {
    stamp();
    const { container, unmount } = await mount(<AskFirst row={{ ...row, ask_first: true }} team={null} />);
    expect(sw(container).disabled).toBe(true);
    expect(container.querySelector("[data-vault-held]")!.getAttribute("aria-label")).toBe(PERSON_ONLY.askFirstOff);
    unmount();
  });

  test("in an agent's tab, off can still be turned on", async () => {
    stamp();
    const { container, unmount } = await mount(<AskFirst row={{ ...row, ask_first: false }} team={null} />);
    expect(sw(container).disabled).toBe(false);
    expect(container.querySelector("[data-vault-held]")).toBeNull();
    unmount();
  });

  test("in a person's tab, on can be turned off", async () => {
    const { container, unmount } = await mount(<AskFirst row={{ ...row, ask_first: true }} team={null} />);
    expect(sw(container).disabled).toBe(false);
    unmount();
  });
});
