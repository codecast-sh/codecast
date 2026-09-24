import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { MintTokenHarness, mintCalls } = await import("./mintToken");
const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey)).toString("base64");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label)!;
const click = (label: string) => act(async () => { button(label).click(); });

beforeEach(async () => {
  mintCalls.length = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<MintTokenHarness publicKey={publicKey} />));
  await click("minting…");
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
afterAll(() => { dom.window.close(); restore(); });

test("Cancel stops the mint and closes the dialog", async () => {
  await click("Cancel mint");
  expect(mintCalls.at(-1)?.name).toBe("accountSwitch:cancelMintToken");
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(button("mint token")).toBeDefined();
});

test("the close icon also cancels", async () => {
  await click("Close");
  expect(mintCalls.at(-1)?.name).toBe("accountSwitch:cancelMintToken");
  expect(document.querySelector("[role=dialog]")).toBeNull();
});

test("different account cancels before showing the chooser", async () => {
  await click("Use a different account");
  expect(mintCalls.at(-1)?.name).toBe("accountSwitch:cancelMintToken");
  const select = document.querySelector("select")!;
  await act(() => { select.value = "home"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await click("Start, open the sign in");
  expect(mintCalls.at(-1)).toMatchObject({ name: "accountSwitch:requestMintToken", args: { profile: "home", device_id: "fixture-mini" } });
  expect(document.body.textContent).toContain("Mint a token for home@example.com");
  expect(button("Cancel mint")).toBeDefined();
  expect(document.querySelector("select")).toBeNull();
});

test("approval code is sealed to the device and success replaces waiting", async () => {
  const input = document.querySelector("input")!;
  expect(new RegExp(`^(?:${input.pattern})$`, "v").test("fixture_code#state")).toBe(true);
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "fixture_code#state");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    const deadline = Date.now() + 10_000;
    while (!mintCalls.some(call => call.name === "accountSwitch:submitMintCode") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
  const sent = mintCalls.at(-1)!;
  expect(sent.name).toBe("accountSwitch:submitMintCode");
  expect(sent.args.payload.provider).toBe("claude-mint-code");
  expect(JSON.stringify(sent.args)).not.toContain("fixture_code");
  expect(document.body.textContent).toContain("Token stored");
  expect(button("Done")).toBeDefined();
});


test("cancelling a slow start exits immediately and cancels the returned attempt", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  await act(() => root.render(<MintTokenHarness key="slow" publicKey={publicKey} initiallyPending={false} startGate={gate} />));
  await click("mint token");
  await click("Start, open the sign in");
  await click("Cancel mint");
  expect(document.querySelector("[role=dialog]")).toBeNull();
  await act(async () => { release(); await gate; });
  expect(mintCalls.map(call => call.name)).toEqual(["accountSwitch:requestMintToken", "accountSwitch:cancelMintToken"]);
  expect(button("mint token")).toBeDefined();
});
