import { afterAll, expect, test, mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getFunctionName } = await import("convex/server");
const convex = await import("convex/react");
const replies = new Map<string, any>();
mock.module("convex/react", () => ({
  ...convex,
  useQueries: (queries: Record<string, any>) => Object.fromEntries(Object.entries(queries).map(([key, request]) => [key, replies.get(getFunctionName(request.query))])),
  useMutation: () => async () => {},
}));
const { useInboxStore } = await import("../../../store/inboxStore");
const { ComposerOwnerStrip } = await import("../../conversation/ComposerOwnerStrip");
const { composerSendRoute, useComposerOwnership } = await import("../../../lib/composerOwnership");
const { withTeamRoster } = await import("../../../test-helpers/teamRoster");

// The line above a session's composer (ComposerOwnerStrip): what sending does
// to who drives, in each state, and the one write each control makes.
const id = "c".repeat(32);
const me = { _id: "me", name: "Ashot" };
const ROLE = { role_id: "role1", short_id: "or-1", handle: "evals", name: "Eval Suite lead", avatar: null };
useInboxStore.setState({
  currentUser: me as any,
  ...withTeamRoster([me, { _id: "jason", name: "Jason" }], { clientState: useInboxStore.getState().clientState }),
  sessions: {},
});
const container = document.getElementById("root")!;
const root = createRoot(container);
afterAll(async () => { await act(async () => root.unmount()); dom.window.close(); });

const setSession = async (row: Record<string, any>, owners: string[], extra: Record<string, any> = {}) => {
  await act(async () => { useInboxStore.setState({ conversations: { [id]: { _id: id, user_id: "me", ...row } } }); });
  replies.set("sessionOwnership:listOwners", {
    conversation_id: id, short_id: "jx1", owners: owners.map((u) => ({ user_id: u, name: u === "me" ? "Ashot" : "Jason" })), owner_ids: owners,
    role: row.org_role_id ? ROLE : null, runner: null, author_id: null, bots: [], can_edit: true, ...extra,
  });
};
let generation = 0;
const render = async (active: boolean) => {
  generation++;
  await act(async () => { root.render(<ComposerOwnerStrip key={generation} conversationId={id} active={active} />); });
};
const strip = () => container.querySelector<HTMLElement>("[data-cc-owner-strip]");
const sendAs = () => useComposerOwnership.getState().sendAs[id] ?? null;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };

test("a role drives: the line shows only while the composer is in use, and says the send takes over", async () => {
  await setSession({ org_role_id: "role1" }, ["me"]);
  await render(false);
  expect(strip()).toBeNull();
  await render(true);
  expect(strip()?.dataset.ccOwnerStrip).toBe("role");
  expect(strip()!.textContent).toContain("Eval Suite drives · sending takes over");
  // The name leads, so a narrow screen cuts the rest, and the key that sends ends the line.
  expect(strip()!.querySelector("b")!.parentElement!.firstElementChild!.textContent).toBe("Eval Suite");
  expect(strip()!.querySelector("[data-owner-strip-key]")!.textContent).toBe("↵take over");
  expect([...strip()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Take over", "Tell Eval Suite"]);
  expect(sendAs()).toEqual({ label: "Take over", tellRole: null });
  expect(composerSendRoute(id)).toBe("take-over");
});

test("Tell keeps the role driving: the line, the send label and the send's route follow the choice", async () => {
  await setSession({ org_role_id: "role1" }, ["me"]);
  await render(true);
  await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Tell Eval Suite"));
  expect(strip()!.textContent).toContain("Eval Suite stays driver · your words go to them");
  expect(strip()!.querySelector("[data-owner-strip-key]")!.textContent).toBe("↵tell");
  expect(sendAs()).toEqual({ label: "Tell Eval Suite", tellRole: "Eval Suite lead" });
  expect(composerSendRoute(id)).toBe("tell-role");
  // The choice holds for the session until changed.
  await render(true);
  expect(strip()!.textContent).toContain("Eval Suite stays driver");
  await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Take over"));
  expect(composerSendRoute(id)).toBe("take-over");
});

test("another person drives: the line names them; Tell sends here and leaves them driving", async () => {
  await setSession({ driver_user_id: "jason", user_id: "jason" }, ["jason", "me"]);
  await render(true);
  expect(strip()?.dataset.ccOwnerStrip).toBe("person");
  expect(strip()!.textContent).toContain("Jason drives · sending takes over");
  expect([...strip()!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Take over", "Tell Jason"]);
  expect(sendAs()?.label).toBe("Take over");
  await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Tell Jason"));
  expect(strip()!.textContent).toContain("Jason stays driver");
  expect(sendAs()).toEqual({ label: "Tell Jason", tellRole: null });
  // Into this session, without the wheel: a person is told where they drive.
  expect(composerSendRoute(id)).toBe("plain");
  await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Take over"));
});

test("you drive and the role is paused: Make driver hands it back on the session row", async () => {
  await setSession({ org_role_id: "role1", driver_user_id: "me" }, ["me"]);
  await render(false);
  expect(strip()?.dataset.ccOwnerStrip).toBe("paused");
  expect(strip()!.textContent).toContain("Eval Suite lead paused while you drive.");
  expect(strip()!.querySelector(".own-paused")).not.toBeNull();
  expect(sendAs()).toBeNull();
  await click([...strip()!.querySelectorAll("button")].find((b) => b.textContent === "Make driver"));
  expect((useInboxStore.getState() as any).conversations[id].driver_user_id ?? null).toBeNull();
});

test("nothing for the driver of an unfiled session, or for someone who neither owns nor runs it", async () => {
  await setSession({}, ["me"]);
  await render(true);
  expect(strip()).toBeNull();
  await setSession({ org_role_id: "role1", user_id: "jason" }, ["jason"]);
  await render(true);
  expect(strip()).toBeNull();
});

test("an owners answer without the role's face names it from the session row's own snapshot", async () => {
  await setSession({ org_role_id: "role1", role: { _id: "role1", short_id: "or-1", handle: "dance", name: "Dance tutor", avatar: "fox" } }, ["me"], { role: null });
  await render(true);
  expect(strip()!.textContent).toContain("Dance tutor drives");
});

test("a send that asks for the wheel paints it on the session row before the server answers; any other send paints nothing", async () => {
  await setSession({ org_role_id: "role1" }, ["me"]);
  await render(true);
  await act(async () => { useInboxStore.getState().sendMessage(id, "Decision: Yes", undefined, "client-0"); });
  expect((useInboxStore.getState() as any).conversations[id].driver_user_id ?? null).toBeNull();
  await act(async () => { useInboxStore.getState().sendMessage(id, "I'll take it from here", undefined, "client-1", undefined, { take_over: true }); });
  expect((useInboxStore.getState() as any).conversations[id].driver_user_id).toBe("me");
  expect(strip()?.dataset.ccOwnerStrip).toBe("paused");
});
