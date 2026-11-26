// The new-session composer's Hidden / Summary / Full picker over what
// creationTeam answers for the folder: it opens on the folder's default, a
// press lands on the stub row that createSessionFromStub folds into the
// create, and a Team pick hides it.
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

let destination: any = null;
const realQuery = { ...(await import("../../hooks/useQueryNoThrow")) };
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: () => ({ data: destination, error: undefined, retry() {} }),
}));
const { useInboxStore } = await import("../../store/inboxStore");
const { NewSessionVisibilityPicker } = await import("../conversation/sessionControls");

const STUB = "visibilitypickerstub1";
let root: Root;
const segments = () => [...document.querySelectorAll("[role=radio]")].map((b) => b.getAttribute("aria-label"));
const checked = () => document.querySelector("[role=radio][aria-checked=true]")?.getAttribute("aria-label") ?? null;
const render = () => act(async () => root.render(<NewSessionVisibilityPicker conversation={{ _id: STUB } as any} />));
const pick = (label: string) => act(async () => {
  [...document.querySelectorAll("[role=radio]")].find((b) => b.getAttribute("aria-label") === label)!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
});
const row = () => useInboxStore.getState().sessions[STUB] as any;
const team = (visibility: string) => ({ team_id: "t1", team_name: "Acme", team_sessions: true, visibility });

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  useInboxStore.setState({
    sessions: { ...useInboxStore.getState().sessions, [STUB]: { _id: STUB, session_id: STUB, updated_at: 1, agent_type: "claude_code", project_path: "/tmp/proj", message_count: 0 } as any },
  } as any);
});
afterEach(async () => {
  await act(async () => root.unmount());
  const sessions = { ...useInboxStore.getState().sessions };
  delete (sessions as any)[STUB];
  useInboxStore.setState({ sessions } as any);
});
afterAll(() => closeDomWindow(dom));

test("no team to see it draws nothing", async () => {
  destination = null;
  await render();
  expect(segments()).toEqual([]);
});

test("the share popover's three levels, opening on the folder's default", async () => {
  destination = team("full");
  await render();
  expect(segments()).toEqual(["Hidden", "Summary", "Full"]);
  expect(checked()).toBe("Full");
  destination = team("private");
  await render();
  expect(checked()).toBe("Hidden");
  destination = team("activity");
  await render();
  expect(checked()).toBeNull();
});

test("a pick lands on the stub and shows", async () => {
  destination = team("full");
  await render();
  await pick("Hidden");
  expect(row()._visibility).toBe("private");
  expect(checked()).toBe("Hidden");
  await pick("Summary");
  expect(row()._visibility).toBe("summary");
});

test("a Team pick hides it", async () => {
  destination = team("full");
  useInboxStore.getState().setStubTeam(STUB, "team");
  await render();
  expect(segments()).toEqual([]);
});
