// A repository's face (RepoFace): the first letter of its name on a tile in
// the accent its name picks until the server has drawn one, asking for the
// drawing once; the drawn icon once its row reaches the store. Only the Convex
// transport is faked.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { pickRoleIconAccent } from "@codecast/shared/contracts/roleIcon";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const asks: any[] = [];
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async (args: any) => { asks.push(args); },
}));

const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { RepoFace } = await import("../RepoFace");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const WS = "user:jx7user000000000000000000000001";
const wrench = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === "wrench")!.icon;

function mount(repository: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<><RepoFace workspace={WS} repository={repository} /><RepoFace workspace={WS} repository={repository} size={44} /></>));
  return { host, unmount: () => act(() => root.unmount()) };
}

describe("RepoFace", () => {
  beforeEach(() => {
    asks.length = 0;
    useInboxStore.setState({ repoIcons: {} } as any);
  });

  test("a monogram in the name's accent until drawn, never asking; the drawn icon when its row arrives", async () => {
    const { host, unmount } = mount("Acme/Web-App");
    const tiles = host.querySelectorAll("[data-role-tile]");
    expect(tiles).toHaveLength(2);
    const tile = tiles[0] as HTMLElement;
    expect(tile.getAttribute("data-role-tile")).toBe("monogram");
    expect(tile.textContent).toBe("W");
    expect(tile.getAttribute("aria-label")).toBe("Web-App");
    expect(tile.style.getPropertyValue("--rt-accent")).toBe(`var(--sol-${pickRoleIconAccent([], "acme/web-app")})`);
    // A face never asks the server for a drawing: the run that records a deploy does (convex lib/runDeploy.ts).
    expect(asks).toEqual([]);

    await act(async () => {
      useInboxStore.getState().syncTable("repoIcons", [{ _id: "ri_1", workspace: WS, repository: "acme/web-app", icon: wrench }], { isDelta: true });
      await new Promise((r) => setTimeout(r, 50));
    });
    const drawn = host.querySelector("[data-role-tile]") as HTMLElement;
    expect(drawn.getAttribute("data-role-tile")).toBe("wrench");
    expect(drawn.querySelector("svg")).not.toBeNull();
    expect(drawn.style.getPropertyValue("--rt-accent")).toBe(`var(--sol-${wrench.accent})`);
    expect(asks).toEqual([]);
    unmount();
  });

  test("a face already drawn in the store paints it at once and asks for nothing; another workspace's drawing is not its own", () => {
    act(() => useInboxStore.getState().syncTable("repoIcons", [
      { _id: "ri_1", workspace: WS, repository: "acme/app", icon: wrench },
      { _id: "ri_2", workspace: "team:jx7team00000000000000000000001", repository: "acme/other", icon: wrench },
    ], { isDelta: true }));
    const a = mount("acme/app");
    expect(a.host.querySelector("[data-role-tile]")!.getAttribute("data-role-tile")).toBe("wrench");
    expect(asks).toEqual([]);
    a.unmount();
    const b = mount("acme/other");
    expect(b.host.querySelector("[data-role-tile]")!.getAttribute("data-role-tile")).toBe("monogram");
    b.unmount();
  });

  test("the monogram wears the color the server settled, and keeps it when the drawing lands", async () => {
    const settled = pickRoleIconAccent([], "acme/app") === "orange" ? "violet" : "orange";
    act(() => useInboxStore.getState().syncTable("repoIcons", [{ _id: "ri_1", workspace: WS, repository: "acme/app", accent: settled, icon: null }], { isDelta: true }));
    const { host, unmount } = mount("acme/app");
    const accentOf = () => (host.querySelector("[data-role-tile]") as HTMLElement).style.getPropertyValue("--rt-accent");
    expect(host.querySelector("[data-role-tile]")!.getAttribute("data-role-tile")).toBe("monogram");
    expect(accentOf()).toBe(`var(--sol-${settled})`);
    await act(async () => {
      useInboxStore.getState().syncTable("repoIcons", [{ _id: "ri_1", workspace: WS, repository: "acme/app", accent: settled, icon: { ...wrench, accent: settled } }], { isDelta: true });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(host.querySelector("[data-role-tile]")!.getAttribute("data-role-tile")).toBe("wrench");
    expect(accentOf()).toBe(`var(--sol-${settled})`);
    unmount();
  });
});
