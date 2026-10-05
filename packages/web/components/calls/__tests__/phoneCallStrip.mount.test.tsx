// The phone's call strip: the header's call card, drawn alone under the
// header where a phone's top bar has no room for the face row. Shown below
// `sm` only; for a call it carries the card's accessories (REC and its Stop,
// Record, the door to the stage) and steps aside while the stage is open,
// since the stage carries them itself; a ring shows even then, so a phone
// can answer one. Mounted in jsdom with the row, the stage and the card
// stubbed.
// Run: bun test --timeout 120000 components/calls/__tests__/phoneCallStrip.mount.test.tsx
import { beforeAll, expect, mock, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let PhoneCallStrip: typeof import("../PhoneCallStrip").PhoneCallStrip;

let narrow = true;
let stageOpen = false;
let card: any = { kind: "none" };

const live = { kind: "live", roomKey: "channel:c1", mute: true, muted: false, end: true };
const joined = { kind: "joined-notice", roomKey: "channel:c1", text: "Ann joined", end: true, mute: true, muted: false, camera: false, cameraOn: false };
const ring = { kind: "ring-in", roomKey: "dm:a:b", from: "u2", name: "Ann", answer: true, decline: true };

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // The strip reads BELOW_SM through the real useMediaQuery; this answers it.
  (window as any).matchMedia = () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} });
  React = await import("react");
  const h = React.createElement;
  mock.module("../../../hooks/useFaceRow", () => ({ useFaceRow: () => ({ card }) }));
  mock.module("../../../lib/calls/callStage", () => ({ useCallStageOpen: () => stageOpen }));
  mock.module("../../faces/EngagementCard", () => ({
    EngagementCard: ({ card, accessory }: any) => h("div", { "data-card": card.kind }, accessory || null),
  }));
  mock.module("../CallCardAccessories", () => ({ CallCardAccessories: () => h("span", { "data-accessories": true }) }));
  ({ createRoot } = await import("react-dom/client"));
  ({ PhoneCallStrip } = await import("../PhoneCallStrip"));
}, 120_000);

function render(): { strip: Element | null; accessories: boolean; kind: string | null } {
  const host = document.getElementById("root")!;
  host.innerHTML = "";
  const root = createRoot(host);
  React.act(() => root.render(React.createElement(PhoneCallStrip)));
  const strip = host.querySelector("[data-phone-call-strip]");
  const out = {
    strip,
    accessories: !!host.querySelector("[data-accessories]"),
    kind: host.querySelector("[data-card]")?.getAttribute("data-card") ?? null,
  };
  React.act(() => root.unmount());
  return out;
}

test("at sm and up the header's own card is there, so the strip is not", () => {
  narrow = false;
  stageOpen = false;
  card = live;
  expect(render().strip).toBeNull();
  narrow = true;
});

test("no card, no strip", () => {
  card = { kind: "none" };
  stageOpen = false;
  expect(render().strip).toBeNull();
});

test("a call's card shows with its accessories while the stage is closed", () => {
  stageOpen = false;
  for (const c of [live, joined]) {
    card = c;
    expect(render()).toMatchObject({ kind: c.kind, accessories: true });
  }
});

test("a call's card steps aside while the stage is open", () => {
  stageOpen = true;
  card = live;
  expect(render().strip).toBeNull();
  stageOpen = false;
});

test("a ring shows even over the stage, and carries no call accessories", () => {
  card = ring;
  for (const open of [false, true]) {
    stageOpen = open;
    expect(render()).toMatchObject({ kind: "ring-in", accessories: false });
  }
  stageOpen = false;
});
