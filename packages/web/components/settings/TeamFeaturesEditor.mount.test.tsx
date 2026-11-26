// Settings → Team → Features: a feature still in development (session owners
// among them) can be turned on by staff only; any admin sees its switch held.
// Run: cd packages/web && bun test components/settings/TeamFeaturesEditor.mount.test.tsx
import { afterAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.sh/settings/team" });
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
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { TeamFeaturesEditor } = await import("./TeamFeaturesEditor");
const { useInboxStore } = await import("../../store/inboxStore");
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const TEAM = "teams_t" as any;

async function switchFor(name: string, staff: boolean): Promise<HTMLButtonElement> {
  useInboxStore.setState({ teams: [{ _id: TEAM, name: "Union", features: {} }] as any, currentUser: { _id: "users_me", staff } as any });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<TeamFeaturesEditor teamId={TEAM} isAdmin />));
  const button = container.querySelector(`[aria-label="${name}"]`) as HTMLButtonElement;
  await act(() => root.unmount());
  return button;
}

describe("TeamFeaturesEditor", () => {
  test("an admin who is not staff cannot turn session owners on; staff can", async () => {
    expect((await switchFor("Session owners", false)).disabled).toBe(true);
    expect((await switchFor("Session owners", true)).disabled).toBe(false);
    // A feature that is not in development stays an admin's to flip.
    expect((await switchFor("Ship", false)).disabled).toBe(false);
  });
});
