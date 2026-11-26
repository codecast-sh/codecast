// A repository's pull requests: a recently merged row's reach word ("live", "not live yet") links into /deploys at
// that pull request on its repository. Only the transport is faked: the pulls read, the viewer and the reach row.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));
const NOW = Date.now();
const pull = (number: number, over: any = {}) => ({
  number, title: `PR ${number}`, state: "closed", draft: false, merged_at: NOW - 3_600_000, created_at: NOW - 7_200_000,
  updated_at: NOW - 3_600_000, closed_at: NOW - 3_600_000, labels: [], html_url: "", shepherd_enabled: false, ...over,
});
mock.module("../../hooks/useRepoBrowse", () => ({
  useRepoPulls: () => ({ ready: true, error: null, data: { pulls: [pull(101)] } }),
}));
mock.module("../../hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }) }));
mock.module("../../hooks/useDeployReach", () => ({ useDeployReach: () => ({ state: "waiting", targets: [{ target: "web", state: "waiting" }] }) }));

const { createRoot } = await import("react-dom/client");
const { RepoPullsContent } = await import("./RepoPullsContent");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("a merged pull request's reach word opens the Deploys page at that pull request", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<RepoPullsContent repository="acme/app" family={"repo" as any} />));
  const merged = [...host.querySelectorAll("[role=tab]")].find((b) => b.textContent === "Merged") as HTMLButtonElement;
  act(() => merged.click());
  const reach = host.querySelector("[data-pull-reach]")!;
  expect(reach.tagName).toBe("A");
  expect(reach.getAttribute("data-pull-reach")).toBe("waiting");
  expect(reach.getAttribute("href")).toBe("/deploys?repo=acme%2Fapp&pr=101");
  expect(reach.textContent).toBe("not live yet");
  act(() => root.unmount());
});
