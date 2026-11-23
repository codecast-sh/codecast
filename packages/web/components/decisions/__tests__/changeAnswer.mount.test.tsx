import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// A settled decision's page: Change answer opens its options again, a pick
// shows the change whole (from, to, who hears it), and only the confirm
// writes it, as a change. An answer a run already acted on says why it stays.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...realConvex, useMutation: () => async () => null, useQuery: () => undefined }));
const realRuns = { ...(await import("../../../hooks/useSyncWorkflows")) };
mock.module("../../../hooks/useSyncWorkflows", () => ({ ...realRuns, useWorkflowRun: () => null }));
import { useInboxStore, type SessionDecisionItem, type DecisionDetailItem } from "../../../store/inboxStore";
import { DecisionAnswerPanel, useDecisionAnswering } from "../DecisionAnswering";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/decisions/sd-1" });
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
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const answered: any[] = [];
const row = (over: Partial<SessionDecisionItem> = {}): SessionDecisionItem => ({
  _id: "d1", short_id: "sd-1", conversation_id: "c1", session_id: "s", question: "Name sessions by the first message?", session_title: "Session naming",
  options: [{ label: "Yes" }, { label: "No" }], kind: "single", blocking: true, status: "answered", answer_index: 0, resolved_at: 1, created_at: 0,
  answered_by: { kind: "role", id: "r1" }, ...over,
} as SessionDecisionItem);
const detailOf = (d: SessionDecisionItem): DecisionDetailItem => ({ _id: d._id, decision: d, doc: null, task: null, stack: null, ladder: [], asked_users: [{ _id: "u1", name: "Me" }], holder_role: null, grant_offer: null, grant: null } as any);

beforeEach(() => {
  answered.length = 0;
  useInboxStore.setState({ currentUser: { _id: "u1", name: "Me" }, answerDecision: (...args: any[]) => { answered.push(args); }, adoptDecision: () => {} } as any);
});

function Panel({ d }: { d: SessionDecisionItem }) {
  const detail = detailOf(d);
  const a = useDecisionAnswering(d, detail, true);
  return <DecisionAnswerPanel decision={d} detail={detail} answerable a={a} keys={false} />;
}

async function mount(d: SessionDecisionItem) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(<Panel d={d} />));
  return container;
}
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
const button = (c: Element, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

test("Change answer: pick, see from and to, confirm writes a change", async () => {
  const c = await mount(row());
  await click(c.querySelector("[data-decision-change]"));
  expect(c.querySelector("[data-decision-change-pick]")).not.toBeNull();
  const no = [...c.querySelectorAll("[data-decision-change-pick] button, [data-decision-change-pick] [role=button]")].find((b) => b.textContent?.includes("No"));
  await click(no);
  const confirm = c.querySelector("[data-decision-change-confirm]")!;
  expect(confirm.textContent).toContain("Yes");
  expect(confirm.textContent).toContain("No");
  expect(confirm.textContent).toContain("Session naming");
  expect(answered).toHaveLength(0);
  await click(button(confirm, "Change answer"));
  expect(answered).toEqual([["d1", { index: 1, change: true }]]);
});

test("earlier answers list what was replaced", async () => {
  const c = await mount(row({ answer_index: 1, answer_history: [{ status: "answered", answer_index: 0, resolved_at: 1, replaced_at: 2, replaced_by: "u1" }] }));
  expect(c.querySelector("[data-decision-earlier]")?.textContent).toContain("Yes");
});

test("an answer its flow acted on offers no change and says why", async () => {
  const c = await mount(row({ workflow_run_id: "w1" }));
  expect(c.querySelector("[data-decision-change]")).toBeNull();
  expect(c.querySelector("[data-decision-locked]")?.textContent).toContain("flow already acted");
});
