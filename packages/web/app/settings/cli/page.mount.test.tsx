// The Connect your computer page (/settings/cli), where every setup Connect
// press lands. Its one job is handing out the install command, so the command
// and its Copy button are on screen the moment the page opens, from exactly
// one setup token. A person who arrives here must not have to find a button
// first (ct-101828: a new person pressed Connect six times, clicked the
// description and headings, and left without the command).
// Run: cd packages/web && bun test app/settings/cli/page.mount.test.tsx
import { afterAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/settings/cli", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let tokensCreated = 0;
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: () => async () => { tokensCreated += 1; return { token: `setup_tok_${tokensCreated}`, expiresAt: Date.now() + 3_600_000 }; },
  useAction: () => async () => null,
  useQuery: () => undefined,
}));
mock.module("../../../hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { _id: "u_me" } }) }));
mock.module("../../../components/settings/BrowserExtensionSetup", () => ({ BrowserExtensionSetup: () => null }));

const { default: CliSettingsPage } = await import("./page");

afterAll(() => { dom.window.close(); });

test("arriving on Connect your computer shows the install command, ready to copy, from one token", async () => {
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<CliSettingsPage />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const text = document.body.textContent ?? "";
  const copy = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Copy");
  expect(text).toContain("codecast.sh/install");
  expect(copy).toBeTruthy();
  expect(tokensCreated).toBe(1);

  await act(async () => root.unmount());
});
