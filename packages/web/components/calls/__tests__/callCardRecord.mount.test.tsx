// Record on the call's card in the header: a person who joined a huddle from
// the header or a knock sees the card, not the stage, so the press must be
// there. The first press asks the room's question below the card; while the
// room records the card's red mark is the Stop, so the button steps aside.
// Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/callCardRecord.mount.test.tsx
import { beforeAll, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let RecordButton: typeof import("../RoomRecording").RecordButton;
let useInboxStore: typeof import("../../../store/inboxStore").useInboxStore;

const ROOM = "channel:design";

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "PointerEvent", "MouseEvent", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key] ?? (dom.window as any).Event, configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ RecordButton } = await import("../RoomRecording"));
  ({ useInboxStore } = await import("../../../store/inboxStore"));
}, 120_000);

const row = (over: Record<string, unknown>) => ({
  _id: ROOM,
  locked: false,
  transcribe_off: false,
  transcribe_off_at: null,
  recording: false,
  recording_configured: true,
  recording_unavailable: null,
  recording_status: null,
  recording_run_id: null,
  ...over,
});

test("the card offers Record while connected, asks first, and steps aside while the room records", () => {
  useInboxStore.getState().syncTable("callRooms", [row({})]);
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  React.act(() => root.render(React.createElement("div", { className: "engagement-card" }, React.createElement(RecordButton, { roomKey: ROOM, variant: "card" }))));
  const button = host.querySelector('[data-card-action="record"]') as HTMLButtonElement | null;
  expect(button?.getAttribute("aria-label")).toBe("Record this huddle");
  expect(button?.className).toContain("engagement-card-toggle");
  // The first press asks the room's question, under the card.
  React.act(() => button!.click());
  expect(host.querySelector('[role="dialog"][aria-label="Record this huddle?"]')).not.toBeNull();
  // Recording: the card's mark is the Stop, so the button draws nothing.
  React.act(() =>
    useInboxStore.getState().syncTable("callRooms", [
      row({ recording: true, recording_status: "recording", recording_run_id: "run1", recording_by_id: "u1", recording_requested_at: 1 }),
    ]),
  );
  console.log("DBG", JSON.stringify((useInboxStore.getState() as any).callRooms[ROOM]), host.innerHTML.slice(0, 300));
  expect(host.querySelector('[data-card-action="record"]')).toBeNull();
  React.act(() => root.unmount());
});

test("a server with recording off offers nothing on the card, and says nothing until it has answered", () => {
  const host = document.getElementById("root")!;
  for (const over of [{ recording_configured: false }, { recording_configured: undefined }]) {
    useInboxStore.getState().syncTable("callRooms", [row(over)]);
    const root = createRoot(host);
    React.act(() => root.render(React.createElement(RecordButton, { roomKey: ROOM, variant: "card" })));
    expect(host.innerHTML).toBe("");
    React.act(() => root.unmount());
  }
});
