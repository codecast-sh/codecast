import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";

process.exitCode = 1;
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
Object.defineProperty(globalThis, "PointerEvent", { configurable: true, value: dom.window.MouseEvent });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const starts: any[] = [];
const joins: string[] = [];
const state = { callOccupancy: {} as Record<string, any[]>, call: { roomKey: null } };
mock.module("../../../lib/teamFeatures", () => ({ useCallsAvailable: () => true }));
mock.module("../../../store/inboxStore", () => ({ useInboxStore: Object.assign((select: any) => select(state), { getState: () => state }), useTrackedStore: () => state }));
mock.module("../../../lib/calls/actions", () => ({ startHuddle: async (opts: any) => { starts.push(opts); }, joinCall: async (room: string) => { joins.push(room); } }));
mock.module("../../../lib/faces/faceRow", () => ({ roomHeldAsBurst: () => false }));
mock.module("../../../hooks/useFaceRow", () => ({ useFaceRowSelect: () => false }));
mock.module("../../../hooks/useWalkie", () => ({ useWalkieStatus: () => null }));
mock.module("../../../lib/calls/walkie", () => ({ walkieHoldsRoom: () => false }));
mock.module("../../../lib/avatarCache", () => ({ AvatarImg: () => null }));
// HuddleWithGuest's guest door, beside the huddle button; not under test here.
mock.module("../../calls/GuestDoor", () => ({ GuestInvite: () => null }));
mock.module("../../../hooks/useLiveRooms", () => ({ useGuestsWaiting: () => [] }));
const { HuddleButton } = await import("../../calls/OccupancyChip");
// The real gate every huddle start passes through (lib/calls/huddleStart):
// with a window hosting its confirm dialog the request waits there, and the
// dialog's Cancel and Start are closeHuddleStart and runHuddleStart.
const gate = await import("../../../lib/calls/huddleStart");
const root = createRoot(document.getElementById("root")!);
const roomKey = "channel:design";
const render = (count?: number, room = roomKey) => act(async () => root.render(<HuddleButton roomKey={room} channelMemberCount={count} anchorTitle="#design" />));
const button = () => document.querySelector<HTMLButtonElement>("[data-huddle-idle]")!;

// A window that draws no dialog starts at once rather than queue one nobody sees.
await render(8);
await act(async () => button().click());
assert.equal(gate.pendingHuddleStart(), null);
assert.deepEqual(starts.pop(), { roomKey, toUserIds: [], anchorTitle: "#design", ringChannel: true });

const unregister = gate.registerHuddleStartHost();
// The request waits for the confirm and carries how many members the buzz reaches.
await act(async () => button().click());
assert.equal(gate.pendingHuddleStart()?.channelMemberCount, 8);
assert.equal(gate.pendingHuddleStart()?.ringChannel, true);
assert.equal(starts.length, 0);
assert.equal(joins.length, 0);
// Cancel starts nothing.
gate.closeHuddleStart();
assert.equal(gate.pendingHuddleStart(), null);
assert.equal(starts.length, 0);
// Start buzzes the channel.
await act(async () => button().click());
gate.runHuddleStart(gate.pendingHuddleStart()!);
assert.equal(gate.pendingHuddleStart(), null);
assert.deepEqual(starts, [{ roomKey, toUserIds: [], anchorTitle: "#design", ringChannel: true }]);
// A channel whose member count is not known yet cannot start.
await render();
assert.equal(button().disabled, true);
// An occupied room is joined at once, no confirm.
state.callOccupancy[roomKey] = [{ user_id: "other", user_name: "Other" }];
await render(8);
await act(async () => document.querySelector<HTMLButtonElement>("#root button")!.click());
assert.deepEqual(joins, [roomKey]);
assert.equal(starts.length, 1);
assert.equal(gate.pendingHuddleStart(), null);
// An empty session room confirms, then joins.
await render(undefined, "session:abc");
await act(async () => button().click());
gate.runHuddleStart(gate.pendingHuddleStart()!);
assert.deepEqual(joins, [roomKey, "session:abc"]);
unregister();
await act(async () => root.unmount());
dom.window.close();
process.exitCode = 0;
