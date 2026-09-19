import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { useInboxStore } from "../../store/inboxStore";
import { FollowPill } from "../presence/FollowPill";

import { closeDomWindow } from "../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const ann = { _id: "u-ann", name: "Ann Lee", presence_state: "active" };

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(<FollowPill />));
  return { container, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  useInboxStore.setState({ followLeaderId: null, followBlocked: false, followedBy: [], teamMembers: [] } as any);
});

describe("FollowPill", () => {
  test("nothing when neither following nor followed", async () => {
    const r = await render();
    expect(r.container.innerHTML).toBe("");
    await r.unmount();
  });

  test("following: the leader's face, the name, a stop that ends the follow, and the blocked wording", async () => {
    useInboxStore.setState({ followLeaderId: "u-ann", teamMembers: [ann] } as any);
    const r = await render();
    expect(r.container.querySelector("[data-sv-follow-pill='following']")).not.toBeNull();
    expect(r.container.textContent).toContain("Following Ann");
    await act(() => { useInboxStore.getState().setFollowBlocked(true); });
    expect(r.container.textContent).toContain("Ann is somewhere you can't open");
    const stop = r.container.querySelector("button[aria-label='Stop following Ann']") as HTMLButtonElement;
    expect(stop).not.toBeNull();
    await act(() => { stop.click(); });
    expect(useInboxStore.getState().followLeaderId).toBeNull();
    expect(r.container.innerHTML).toBe("");
    await r.unmount();
  });

  test("followed: faces and the sentence", async () => {
    useInboxStore.setState({ followedBy: [{ user_id: "b", name: "Bob Stone" }, { user_id: "c", name: "Cy" }] } as any);
    const r = await render();
    expect(r.container.querySelector("[data-sv-follow-pill='followed']")).not.toBeNull();
    expect(r.container.textContent).toContain("Bob and Cy are following you");
    await r.unmount();
  });
});
