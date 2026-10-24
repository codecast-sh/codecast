import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

// Each server call by name; a test sets what a name answers.
const calls: Array<{ name: string; args: any }> = [];
let answers: Record<string, (args: any) => any> = {};
const call = (name: string) => async (args: any) => {
  calls.push({ name, args });
  return await answers[name]?.(args);
};
const { getFunctionName } = await import("convex/server");
const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useMutation: (ref: any) => call(getFunctionName(ref)),
  useAction: (ref: any) => call(getFunctionName(ref)),
}));
const toasts: Array<{ kind: string; text: string }> = [];
const sonner = await import("sonner");
mock.module("sonner", () => ({
  ...sonner,
  toast: Object.assign((text: string) => toasts.push({ kind: "plain", text }), {
    success: (text: string) => toasts.push({ kind: "success", text }),
    error: (text: string) => toasts.push({ kind: "error", text }),
    warning: (text: string) => toasts.push({ kind: "warning", text }),
  }),
}));
// The popover's own behaviour is Radix's; render its content in place.
mock.module("../ui/popover", () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));
const { ReviewMenu } = await import("./PRActions");

const pr = { _id: "pr_1", repository: "codecast-sh/codecast", number: 12, state: "open", shepherd_conversation_id: "conv_1", author_github_username: "sam" };
const notes = [
  { _id: "n1", file_path: "src/a.ts", line_number: 4, content: "rename this", created_at: 1 },
  { _id: "n2", file_path: "src/b.ts", line_number: 9, content: "test this", created_at: 2 },
] as any[];

let root: Root;
const render = () => act(async () => root.render(
  <ReviewMenu pr={pr} notes={notes} authorLogin="ashot" onNavigate={() => {}} open onOpenChange={() => {}} />,
));
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
const press = (el: Element) => act(async () => { (el as HTMLButtonElement).click(); await new Promise((r) => setTimeout(r, 0)); });
const handCalls = () => calls.filter((c) => c.name === "reviews:handPendingToSession");

beforeEach(async () => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  calls.length = 0;
  toasts.length = 0;
  answers = {};
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("Review popover: send to session", () => {
  test("a plain send carries no resolve flag and an old backend's answer still reads as sent", async () => {
    // A backend from before outcomes answers only the old fields.
    answers["reviews:handPendingToSession"] = () => ({ sent: 2, conversation_id: "conv_1", short_id: "jx7abcd" });
    await press(button("Send to session"));
    expect(handCalls()).toHaveLength(1);
    expect("resolve" in handCalls()[0].args).toBe(false);
    expect(toasts).toEqual([{ kind: "success", text: "2 notes sent to jx7abcd" }]);
  });

  test("and resolve: the choice rides the send and the outcome is shown", async () => {
    answers["reviews:handPendingToSession"] = () => ({
      sent: 2, conversation_id: "conv_1", short_id: "jx7abcd",
      outcome: { kind: "sent_and_resolved", sent_ids: ["n1", "n2"], waiting: "busy" },
    });
    const toggle = document.querySelector("[data-pr-hand-resolve]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await press(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await press(button("Send to session"));
    expect(handCalls()[0].args).toMatchObject({ pull_request_id: "pr_1", resolve: true });
    expect(toasts).toEqual([{ kind: "success", text: "2 notes sent to jx7abcd, queued until its turn ends and resolved" }]);
  });

  test("a failed send stays on screen with a retry, never a clipboard fallback", async () => {
    answers["reviews:handPendingToSession"] = () => { throw new Error("No session matches conv_1"); };
    await press(button("Send to session"));
    const row = document.querySelector("[data-pr-hand-outcome]")!;
    expect(row.getAttribute("data-pr-hand-outcome")).toBe("failed");
    expect(row.textContent).toContain("Not sent: No session matches conv_1");
    expect(toasts).toEqual([]);

    answers["reviews:handPendingToSession"] = () => ({ sent: 2, conversation_id: "conv_1", outcome: { kind: "sent", sent_ids: ["n1", "n2"] } });
    await press(document.querySelector("[data-pr-hand-retry]")!);
    expect(handCalls()).toHaveLength(2);
    expect(document.querySelector("[data-pr-hand-outcome]")).toBeNull();
    expect(toasts[0].kind).toBe("success");
  });

  test("a resolve that left notes open resolves just those on retry", async () => {
    answers["reviews:handPendingToSession"] = () => ({
      sent: 2, conversation_id: "conv_1",
      outcome: { kind: "resolve_failed", sent_ids: ["n1", "n2"], open_ids: ["n2"], reason: "write conflict" },
    });
    await press(document.querySelector("[data-pr-hand-resolve]")!);
    await press(button("Send to session"));
    expect(document.querySelector("[data-pr-hand-outcome]")!.textContent).toContain("1 note still open: write conflict");
    const { useInboxStore } = await import("../../store/inboxStore");
    const resolved: Array<[string[], boolean]> = [];
    const real = useInboxStore.getState().resolveCodeCommentThread;
    useInboxStore.setState({ resolveCodeCommentThread: (ids: string[], on: boolean) => { resolved.push([ids, on]); } } as any);
    try {
      await press(button("Resolve again"));
    } finally {
      useInboxStore.setState({ resolveCodeCommentThread: real } as any);
    }
    // Through the store action that owns code comment resolves, open ids only.
    expect(resolved).toEqual([[["n2"], true]]);
    // The send is not repeated.
    expect(handCalls()).toHaveLength(1);
    expect(toasts).toEqual([{ kind: "success", text: "2 notes sent to the session and resolved" }]);
  });
});
