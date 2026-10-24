// A login's masked 2FA row has copy beside the eye, the same as its username
// and password rows: a press fetches the seed and copies the current code,
// without revealing it first.
// Run: cd packages/web && bun test components/secrets/TotpCode.mount.test.tsx
import { afterAll, beforeAll, expect, test } from "bun:test";
import { totp } from "@codecast/shared/contracts/secrets";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const SEED = "JBSWY3DPEHPK3PXP";

let dom: import("jsdom").JSDOM;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let parts: typeof import("./parts");
const copied: string[] = [];

// Loading React and the Vault parts cold takes seconds on a busy machine, so it runs under its own timeout.
beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  parts = await import("./parts");
}, 60_000);

afterAll(() => closeDomWindow(dom));

test("copy on the masked 2FA row fetches the seed and copies the current code", async () => {
  const { act } = React;
  let fetches = 0;
  const fetchSeed = async () => (fetches++, SEED);
  const root = createRoot(document.getElementById("root")!);
  act(() => root.render(React.createElement(parts.TotpCode, { seed: undefined, fetchSeed })));

  expect(document.querySelector("[data-vault-totp]")?.getAttribute("data-vault-totp")).toBe("masked");
  expect(document.querySelector("[data-vault-show-code]")).not.toBeNull();
  const before = (await totp(SEED)).code;
  await act(async () => (document.querySelector("[data-vault-copy]") as HTMLButtonElement).click());
  const after = (await totp(SEED)).code;
  await act(async () => {});

  expect(fetches).toBe(1);
  expect(copied).toHaveLength(1);
  expect([before, after]).toContain(copied[0]);
  expect(document.querySelector("[data-vault-copy]")?.textContent).toBe("Copied");
  act(() => root.unmount());
});
