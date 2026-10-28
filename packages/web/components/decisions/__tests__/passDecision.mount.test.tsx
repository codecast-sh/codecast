import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

// Pass takes a note and Escalate sits beside it (convex decisionHandoff.ts):
// picking a teammate opens a note step, and Escalate names whom it goes to and
// will not send without a note. The card then shows the note to its new owner.
mock.module("next/link", () => ({ default: ({ children, href, ...rest }: any) => <a href={typeof href === "string" ? href : "#"} {...rest}>{children}</a> }));
import { useInboxStore } from "../../../store/inboxStore";
import { PassDecision } from "../PassDecision";
import { HandoffNote } from "../DecisionParties";
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
const { createRoot } = await import("react-dom/client");
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const passed: any[] = [];
const escalated: any[] = [];
beforeEach(() => {
  passed.length = 0;
  escalated.length = 0;
  useInboxStore.setState({
    currentUser: { _id: "u1", name: "Me" },
    teamMembers: [{ _id: "u1", name: "Me", role: "member" }, { _id: "u2", name: "Sam", role: "member" }, { _id: "u3", name: "Morgan", role: "admin" }, { _id: "b1", name: "Bot", role: "admin", is_bot: true }],
    orgTree: { workspace: { kind: "team", id: "t1", name: "Acme" }, people: [{ user_id: "u1", reports_to_user_id: "u3" }], roles: [], anchors: [] },
    sessionDecisions: { d1: { _id: "d1", status: "pending", holder_key: "user:u1", holder: { kind: "user", id: "u1" } } },
    passDecision: (...args: any[]) => passed.push(args),
    escalateDecision: (...args: any[]) => escalated.push(args),
  } as any);
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <PassDecision decisionId="d1" open={open} onOpenChange={setOpen} keys={false} />;
}

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(ui));
  return { container, unmount: () => act(() => root.unmount()) };
}
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); });
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
const buttonNamed = (root: Element, words: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(words));

test("Pass: picking a teammate opens a note step, and the note rides the pass", async () => {
  const { container, unmount } = await mount(<Harness />);
  await click(buttonNamed(container, "Pass to"));
  await click([...container.querySelectorAll("button")].find((b) => b.textContent?.endsWith("Sam")));
  const form = container.querySelector("[data-decision-handoff-form=note]")!;
  expect(form.textContent).toContain("Sam");
  await type(form.querySelector("textarea")!, "You know the parser");
  await click(buttonNamed(form, "Pass"));
  expect(passed).toEqual([["d1", { kind: "user", id: "u2" }, "You know the parser"]]);
  expect(container.querySelector("[data-decision-handoff-form]")).toBeNull();
  unmount();
});

test("Escalate: names the owner's manager and sends only with a note", async () => {
  const { container, unmount } = await mount(<Harness />);
  await click(container.querySelector("[data-decision-escalate]"));
  const form = container.querySelector("[data-decision-handoff-form=escalate]")!;
  expect(form.textContent).toContain("Escalate to");
  expect(form.textContent).toContain("Morgan");
  const send = buttonNamed(form, "Escalate") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await click(send);
  expect(escalated).toEqual([]);
  await type(form.querySelector("textarea")!, "Costs money");
  expect((buttonNamed(form, "Escalate") as HTMLButtonElement).disabled).toBe(false);
  await click(buttonNamed(form, "Escalate"));
  expect(escalated).toEqual([["d1", "Costs money"]]);
  unmount();
});

test("the card shows the note to its new owner, escalated or passed", async () => {
  const up = await mount(<HandoffNote decision={{ status: "pending", passed_to: { id: "u3", kind: "user", by: "u1", note: "Costs money" }, escalated: { at: 1, by: "u1", note: "Costs money", to: ["u3"] } } as any} />);
  expect(up.container.querySelector("[data-decision-handoff=escalated]")?.textContent).toContain("Costs money");
  up.unmount();
  const pass = await mount(<HandoffNote decision={{ status: "pending", passed_to: { id: "u2", kind: "user", by: "u1", note: "Yours" } } as any} />);
  expect(pass.container.querySelector("[data-decision-handoff=passed]")?.textContent).toContain("Yours");
  pass.unmount();
  const none = await mount(<HandoffNote decision={{ status: "answered", passed_to: { id: "u2", kind: "user", note: "Yours" } } as any} />);
  expect(none.container.innerHTML).toBe("");
  none.unmount();
});
