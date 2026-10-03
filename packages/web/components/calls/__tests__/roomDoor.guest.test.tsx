import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The door with a guest at it: marked as a guest beside a teammate's knock,
// answered with Admit or Deny, and offering to close a link that keeps
// bringing people the room turned away. Somebody who may not answer the door
// sees who is waiting and no buttons that would only fail. Answering a guest
// takes the knock off the door in the same frame (the store's action).

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { RoomKnocks } = await import("../RoomDoor");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ROOM = "channel:c1";
const guest = {
  from_user: "guest:g1",
  from_name: "Ada Lovelace",
  created_at: 10,
  kind: "guest" as const,
  guest_id: "g1",
  link_id: "l1",
  link_turned_away: 0,
  can_answer: true,
};
const teammate = { from_user: "u-bo", from_name: "Bo Diaz", created_at: 5, kind: "person" as const, can_answer: true };

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
async function door(knocks: unknown[]): Promise<string> {
  useInboxStore.setState({ roomKnocks: knocks } as any);
  const host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<RoomKnocks roomKey={ROOM} />));
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

test("a guest knocks beside a teammate: marked, with Deny and Admit; the teammate's knock admits only", async () => {
  const html = await door([teammate, guest]);
  const t = text(html);
  expect(t).toContain("Bo wants to join");
  expect(t).toContain("Ada Lovelace wants to join guest Deny Admit");
  expect(html.match(/aria-label="Admit /g)?.length).toBe(2);
  expect(html.match(/aria-label="Turn .* away"/g)?.length).toBe(1);
  expect(t).not.toContain("turn off link");
});

test("a link that already brought somebody the room turned away offers to close with the answer", async () => {
  const t = text(await door([{ ...guest, link_turned_away: 2 }]));
  expect(t).toContain("2 turned away from this link already");
  expect(t).toContain("Deny and turn off link");
});

test("somebody who may not answer sees who is waiting, and nothing to press", async () => {
  const html = await door([{ ...guest, can_answer: false }]);
  expect(text(html)).toContain("Ada Lovelace is waiting");
  expect(html).not.toContain("<button");
});

test("a guest's knock says whose link brought them", async () => {
  expect(text(await door([{ ...guest, link_by: "Sam Rivera", link_mine: false }]))).toContain("Ada Lovelace wants to join guest · via Sam's link");
  expect(text(await door([{ ...guest, link_by: "Sam Rivera", link_mine: true }]))).toContain("· via your link");
});

test("admitting a guest takes the knock off the door at once", async () => {
  useInboxStore.setState({ roomKnocks: [teammate, guest] } as any);
  const host = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<RoomKnocks roomKey={ROOM} />));
  const admit = host.querySelector('[aria-label="Admit Ada Lovelace"]') as HTMLButtonElement;
  await act(async () => admit.click());
  expect((useInboxStore.getState() as any).roomKnocks.map((k: any) => k.from_user)).toEqual(["u-bo"]);
  expect(text(host.innerHTML)).not.toContain("Ada");
  await act(async () => root.unmount());
  host.remove();
});
