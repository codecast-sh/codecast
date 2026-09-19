import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// Who is in a decision: the session that asked it, the person who holds it,
// and what its category means. The old header said "See the conversation",
// a bare red "unknown" and a plain name — none of which identified anyone.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true }));

import { useInboxStore } from "../../../store/inboxStore";
import { AskingSession, PersonChip, CategoryNote, categoryMeaning } from "../DecisionParties";

import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/questions" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

beforeEach(() => {
  useInboxStore.setState({
    sessions: { c1: { _id: "c1", title: "Rate limit investigation", project_path: "/Users/x/src/codecast", status: "running" } },
    teamMembers: [{ _id: "u1", name: "Jason Benn", github_username: "jasonbenn", image: "https://example.test/j.png" }],
  } as any);
});

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}

const decision: any = { _id: "d1", conversation_id: "c1", question: "Ship it?", session_title: "a stale stamp", project_path: "/Users/x/src/other" };

test("the asking session renders as a line: live dot, its name, its project", async () => {
  const { container, unmount } = await mount(<AskingSession decision={decision} />);
  const line = container.querySelector("[data-asking-session]")!;
  // The live store row wins over the stamp the decision was written with.
  expect(line.textContent).toContain("Rate limit investigation");
  expect(line.textContent).toContain("codecast");
  expect(line.querySelector("a")!.getAttribute("href")).toBe("/conversation/c1");
  unmount();
});

test("a session the store has never seen falls back to its own stamp, then to plain words", async () => {
  const { container: withStamp, unmount: u1 } = await mount(<AskingSession decision={{ ...decision, conversation_id: "gone" }} />);
  expect(withStamp.textContent).toContain("a stale stamp");
  u1();
  const { container: bare, unmount: u2 } = await mount(<AskingSession decision={{ _id: "d2", conversation_id: "gone", question: "?" }} />);
  expect(bare.textContent).toContain("a session with no name yet");
  expect(bare.textContent).not.toContain("See the conversation");
  u2();
});

test("a person renders with their face and links to their profile", async () => {
  const { container, unmount } = await mount(<PersonChip userId="u1" fallbackName="Jason" />);
  const a = container.querySelector("a")!;
  expect(a.getAttribute("href")).toBe("/team/jasonbenn");
  expect(container.querySelector("img")!.getAttribute("src")).toBe("https://example.test/j.png");
  expect(container.textContent).toContain("Jason Benn");
  unmount();
});

test("the category says who may answer, and an unmet one is not an alarm", async () => {
  expect(categoryMeaning(undefined)).toBe("the asker proposed none, so a person answers it");
  expect(categoryMeaning("unknown")).toBe("the asker proposed none, so a person answers it");
  expect(categoryMeaning("approach")).toContain("a role can earn");
  expect(categoryMeaning("production")).toContain("always a person");

  const { container, unmount } = await mount(<CategoryNote category="unknown" />);
  // No chip at all for the absence of a category: the word "unknown" never
  // reaches the reader, and nothing is painted red.
  expect(container.textContent).not.toContain("unknown");
  expect(container.querySelector(".text-sol-red")).toBeNull();
  unmount();

  const { container: pinned, unmount: u2 } = await mount(<CategoryNote category="data" proposed="approach" />);
  expect(pinned.textContent).toContain("data");
  expect(pinned.textContent).toContain("the server pinned it; the asker proposed approach");
  u2();
});
