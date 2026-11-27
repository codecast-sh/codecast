// The Start composer's line before Send (components/priorities/StartLinkNotice):
// silent when the session will land on its priority's team; when it would stay
// private there, it says so and offers one press that shares a summary with
// that team; when its folder belongs to another team, it says that.
// Run: cd packages/web && bun test --isolate components/priorities/StartLinkNotice.mount.test.tsx
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

let destination: any = undefined;
const asked: unknown[] = [];
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: (_ref: unknown, args: unknown) => { asked.push(args); return { data: destination, error: undefined, retry() {} }; },
}));
const { useInboxStore } = await import("../../store/inboxStore");
const { StartLinkNotice } = await import("./StartLinkNotice");

const STUB = "startlinknoticestub1";
let root: Root;
const render = () => act(async () => root.render(<StartLinkNotice conversationId={STUB} />));
const notice = () => document.querySelector("[data-start-link-notice]");
const row = () => useInboxStore.getState().sessions[STUB] as any;

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  asked.length = 0;
  useInboxStore.setState({
    priorities: { p9: { _id: "p9", short_id: "pri-9", workspace: "team:cc" } },
    sessions: { ...useInboxStore.getState().sessions, [STUB]: { _id: STUB, session_id: STUB, updated_at: 1, project_path: "/tmp/scratch", message_count: 0, _start: { priority: "pri-9", priority_step: "s1" } } as any },
  } as any);
});
afterEach(async () => {
  await act(async () => root.unmount());
  const sessions = { ...useInboxStore.getState().sessions };
  delete (sessions as any)[STUB];
  useInboxStore.setState({ sessions } as any);
});
afterAll(() => closeDomWindow(dom));

test("private on the priority's team: it says so, and one press shares a summary with that team", async () => {
  destination = { team_id: "cc", team_name: "Codecast", team_sessions: true, visibility: "private" };
  await render();
  expect(asked.at(-1)).toEqual({ path: "/tmp/scratch", priority: "pri-9" });
  expect(notice()?.getAttribute("data-start-link-notice")).toBe("private");
  const share = document.querySelector("[data-start-share]") as HTMLButtonElement;
  expect(share.textContent).toBe("Share summary with Codecast");
  await act(async () => { share.click(); });
  expect(row()._visibility).toBe("summary");
  expect(notice()).toBeNull();
});

test("shared with the priority's team already: nothing to say", async () => {
  destination = { team_id: "cc", team_name: "Codecast", team_sessions: true, visibility: "full" };
  await render();
  expect(notice()).toBeNull();
});

test("a folder that belongs to another team: it says so, with nothing to press", async () => {
  destination = { team_id: "un", team_name: "Union", team_sessions: true, visibility: "full" };
  await render();
  expect(notice()?.textContent).toBe("This folder belongs to Union: not on pri-9");
  expect(document.querySelector("[data-start-share]")).toBeNull();
});

test("no Start: no notice and no read", async () => {
  useInboxStore.setState({ sessions: { ...useInboxStore.getState().sessions, [STUB]: { ...row(), _start: undefined } } } as any);
  destination = { team_id: "cc", team_name: "Codecast", team_sessions: true, visibility: "private" };
  await render();
  expect(notice()).toBeNull();
  expect(asked.every((a) => a === "skip")).toBe(true);
});
