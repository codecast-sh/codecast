import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// ct-101357 (run rp-25036): two decisions ask the same question about the same
// subject. sd-4675 (on ct-97920) is asked of the viewer and sits in their
// stepper; sd-4677 (on ct-97921, linked to ct-97920 as related) is held by a
// teammate, so the stepper never admits it. The person answered sd-4675 in the
// stepper and then spent eight actions in the Decisions list finding sd-4677 to
// give it the same answer. The card in the stepper must point at the related
// open decision it does not show, by its short id, so one press reaches it.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
mock.module("../../../lib/convexUrl", () => ({ CONVEX_URL: "https://convex.test", getConvexUrl: () => "https://convex.test" }));
mock.module("../../../hooks/useQueryNoThrow", () => ({ useQueryNoThrow: () => ({ data: undefined, error: null }) }));
mock.module("../../../hooks/useSyncPendingPermissions", () => ({ usePendingPermissions: () => undefined }));
mock.module("../../../hooks/useJumpToDecisionAsk", () => ({ useJumpToDecisionAsk: () => async () => true, locateDecisionAsk: async () => null }));
mock.module("../../PublishedPageEmbed", () => ({ PublishedPageEmbed: () => null }));

import { useInboxStore } from "../../../store/inboxStore";
import { SessionDecisionCard } from "../../SessionDecisionCard";
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
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const T = Date.now() - 3_600_000;
const ME = "u_me";
const TEAMMATE = "u_mate";
const options = [
  { label: "Ship it", description: "an introduction goes to the address the person chose" },
  { label: "Follow only a changed main address" },
  { label: "Leave it as is" },
];
const mine: any = {
  _id: "d4675", short_id: "sd-4675", conversation_id: "c1", session_id: "s1", user_id: ME,
  question: "When someone asks us to write to another address of theirs, should their introduction go there?",
  options, kind: "single", blocking: true, status: "pending", created_at: T,
  task_id: "t97920", asked_user_ids: [ME], in_queue: true,
};
const theirs: any = {
  _id: "d4677", short_id: "sd-4677", conversation_id: "c2", session_id: "s2", user_id: TEAMMATE,
  question: "Should an introduction go to the address the person chose, read from their record when it's sent?",
  options, kind: "single", blocking: true, status: "pending", created_at: T + 1000,
  task_id: "t97921", asked_user_ids: [TEAMMATE], in_queue: false,
  holder: { kind: "user", id: TEAMMATE }, holder_key: `user:${TEAMMATE}`,
};
const tasks: any = {
  t97920: { _id: "t97920", short_id: "ct-97920", title: "agent guard recipient_redirected", status: "in_review", related: ["ct-97921"], created_at: T, updated_at: T },
  t97921: { _id: "t97921", short_id: "ct-97921", title: "intro send ignores contact's preferred address", status: "in_review", related: ["ct-97920"], created_at: T, updated_at: T },
};

const item: any = {
  key: "decide:d4675", source: "decide", conversationId: "c1", decisionId: "d4675",
  question: mine.question, options, blocking: true, createdAt: T,
};
const stepper: any = { position: 1, total: 1, onDone: () => {}, onSkip: () => {}, onExit: () => {}, item };

function seed(other: any) {
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Ashot" },
    sessionDecisions: { d4675: mine, d4677: other },
    tasks,
  } as any);
}

async function mount() {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const root = createRoot(pane);
  await act(() => root.render(<MemoryRouter><SessionDecisionCard item={item} stepper={stepper} /></MemoryRouter>));
  return { pane, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => { document.body.innerHTML = ""; });

test("the stepper's card points at the teammate's open decision on a related task, by its short id", async () => {
  seed(theirs);
  const { pane, unmount } = await mount();
  // Sanity: the card under test is the stepper's sd-4675 card.
  expect(pane.textContent).toContain("should their introduction go there");
  // The miss: nothing on it names sd-4677, so the person has to go hunting.
  expect(pane.textContent).toContain("sd-4677");
  await unmount();
});

test("guard: an already-answered related decision is not pointed at", async () => {
  seed({ ...theirs, status: "answered", answer_index: 0 });
  const { pane, unmount } = await mount();
  expect(pane.textContent).toContain("should their introduction go there");
  expect(pane.textContent).not.toContain("sd-4677");
  await unmount();
});
