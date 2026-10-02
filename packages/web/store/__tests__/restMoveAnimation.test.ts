import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { useInboxStore } from "../inboxStore";
import { animatedSetSessionRest } from "../undoActions";

// Filing a row as dormant (or any rest verdict) moves it between inbox
// sections the way a stash moves it out: the card collapses where it was, the
// store write lands once the collapse ends, and the copy that mounts in the
// destination section grows in.
const ID = "jx7restmove0000000000000000000";

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "MutationObserver", "Element", "HTMLElement", "Event"] as const) {
    (globalThis as any)[key] = (dom.window as any)[key];
  }
});

const seed = () => useInboxStore.setState({
  pending: {},
  sessions: { [ID]: { _id: ID, title: "Moving row", updated_at: 1 } } as any,
  conversations: { [ID]: { _id: ID, title: "Moving row" } } as any,
});

const mountCard = (section: string) => {
  const host = document.createElement("section");
  host.dataset.section = section;
  const wrapper = document.createElement("div");
  const card = document.createElement("div");
  card.dataset.sessionId = ID;
  wrapper.appendChild(card);
  host.appendChild(wrapper);
  document.body.appendChild(host);
  return { host, wrapper, card };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a rest verdict animates the row between sections", () => {
  test("collapses the card, stamps after the collapse, and grows the new copy in", async () => {
    document.body.innerHTML = "";
    seed();
    const from = mountCard("needs_input");

    animatedSetSessionRest(ID, "dormant");
    expect(from.wrapper.classList.contains("session-dismissing")).toBe(true);
    expect((useInboxStore.getState().sessions[ID] as any).user_rest).toBeUndefined();

    from.wrapper.dispatchEvent(new Event("animationend"));
    expect((useInboxStore.getState().sessions[ID] as any).user_rest).toBe("dormant");

    // React moves the row: the old section unmounts it, the dormant one mounts it.
    from.host.remove();
    const to = mountCard("dormant");
    await tick();
    expect(to.wrapper.classList.contains("session-entering")).toBe(true);
  });

  test("a row already filed there stays put: no collapse, no entrance", async () => {
    document.body.innerHTML = "";
    seed();
    useInboxStore.getState().setSessionRest(ID, "dormant");
    const at = mountCard("dormant");

    animatedSetSessionRest(ID, "dormant");
    expect(at.wrapper.classList.contains("session-dismissing")).toBe(false);
    await tick();
    expect(at.wrapper.classList.contains("session-entering")).toBe(false);
  });

  test("with no card on screen the verdict lands at once", () => {
    document.body.innerHTML = "";
    seed();
    animatedSetSessionRest(ID, "done");
    expect((useInboxStore.getState().sessions[ID] as any).user_rest).toBe("done");
  });
});
