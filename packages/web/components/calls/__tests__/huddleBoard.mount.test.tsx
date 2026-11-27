import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// Scribe on a huddle's board, as the person sees it: the call's board as a
// stage view, the invite banner while Scribe is absent, the "Next time"
// banner that saves the workspace's defaults, the header chip with Remove,
// the settings section, and the Add picker's first row.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  PointerEvent: dom.window.MouseEvent,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  FocusEvent: dom.window.FocusEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  DOMRect: class { x = 0; y = 0; width = 0; height = 0; top = 0; left = 0; right = 0; bottom = 0; static fromRect() { return {}; } },
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { BoardBanner, BoardStage, ScribeChip } = await import("../HuddleBoard");
const { boardBannerState } = await import("../../../lib/calls/huddleSettings");
const { HuddlesSection } = await import("../CallSettings");
const { openFeedTargetPicker } = await import("../useCallFeed");
const { StageHostProvider } = await import("../stageHost");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const WS = "team:t1";
type Status = "absent" | "joining" | "listening";
const scribeOf = (status: Status, invite = mock(() => {}), remove = mock(() => {})) => ({ present: status !== "absent", status, invite, remove });

beforeEach(() => {
  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: { active_team_id: "t1" } }, teams: [{ _id: "t1", name: "Codecast" }, { _id: "t2", name: "Union" }] }));
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, root, render: (n: React.ReactNode) => act(() => root.render(n)) };
}
const ui = () => useInboxStore.getState().clientState.ui as any;
const button = (c: Element, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

test("which banner shows: invite while absent, Next time after this person invited, none once both are on", () => {
  expect(boardBannerState({ present: false, memo: {}, boardViewOn: false, autoScribeOn: false })).toBe("invite");
  expect(boardBannerState({ present: false, memo: { dismissed: true }, boardViewOn: false, autoScribeOn: false })).toBeNull();
  // Somebody else's Scribe: no banner to save from.
  expect(boardBannerState({ present: true, memo: {}, boardViewOn: false, autoScribeOn: false })).toBeNull();
  expect(boardBannerState({ present: true, memo: { invited: true }, boardViewOn: true, autoScribeOn: false })).toBe("next");
  expect(boardBannerState({ present: true, memo: { invited: true }, boardViewOn: true, autoScribeOn: true })).toBeNull();
  expect(boardBannerState({ present: true, memo: { invited: true, nextClosed: true }, boardViewOn: false, autoScribeOn: false })).toBeNull();
});

test("absent → Invite → Next time → Save writes both settings for that workspace only", async () => {
  const invite = mock(() => {});
  const banner = (status: Status) => <BoardBanner callKey="call-1" workspace={WS} workspaceName="Codecast" scribe={scribeOf(status, invite)} />;
  const m = await mount(banner("absent"));
  expect(m.container.querySelector("[data-banner=invite]")?.textContent).toContain("Scribe lays out this huddle as you talk");
  await act(() => button(m.container, "Invite Scribe")!.click());
  expect(invite).toHaveBeenCalledTimes(1);
  await m.render(banner("joining"));
  const next = m.container.querySelector("[data-banner=next]")!;
  expect(next.textContent).toContain("Next time in Codecast:");
  const boxes = [...next.querySelectorAll("input[type=checkbox]")] as HTMLInputElement[];
  expect(boxes.map((b) => [b.parentElement!.textContent, b.checked])).toEqual([
    ["Open huddles on the board", true],
    ["Invite Scribe", true],
  ]);
  await act(() => button(m.container, "Save")!.click());
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  expect(ui().huddleAutoScribe).toEqual({ [WS]: true });
  expect(m.container.querySelector("[data-banner]")).toBeNull();
  await act(() => m.root.unmount());
});

test("dismissing the invite lasts for the call, across remounts; a new call asks again", async () => {
  const m = await mount(<BoardBanner callKey="call-2" workspace={WS} workspaceName="Codecast" scribe={scribeOf("absent")} />);
  await act(() => (m.container.querySelector("[aria-label='Dismiss for this call']") as HTMLButtonElement).click());
  expect(m.container.querySelector("[data-banner]")).toBeNull();
  await act(() => m.root.unmount());
  const again = await mount(<BoardBanner callKey="call-2" workspace={WS} workspaceName="Codecast" scribe={scribeOf("absent")} />);
  expect(again.container.querySelector("[data-banner]")).toBeNull();
  await again.render(<BoardBanner callKey="call-3" workspace={WS} workspaceName="Codecast" scribe={scribeOf("absent")} />);
  expect(again.container.querySelector("[data-banner=invite]")).not.toBeNull();
  await act(() => again.root.unmount());
});

test("the Next time banner is not offered while both settings are already on", async () => {
  useInboxStore.getState().updateClientUI({ huddleBoardView: { [WS]: true }, huddleAutoScribe: { [WS]: true } });
  const m = await mount(<BoardBanner callKey="call-4" workspace={WS} workspaceName="Codecast" scribe={scribeOf("absent")} />);
  await act(() => button(m.container, "Invite Scribe")!.click());
  await m.render(<BoardBanner callKey="call-4" workspace={WS} workspaceName="Codecast" scribe={scribeOf("listening")} />);
  expect(m.container.querySelector("[data-banner]")).toBeNull();
  await act(() => m.root.unmount());
});

test("board view puts the call's board on the stage, made through pinCallBoard once per call", async () => {
  const pinCallBoard = mock(async () => ({ doc_id: "d1" }));
  const real = useInboxStore.getState().pinCallBoard;
  useInboxStore.setState({ pinCallBoard } as any);
  const PinTile = ({ share }: { share: any }) => <div data-test-pin={share.pin.ref}>{share.pin.doc_type}</div>;
  const stage = (
    <StageHostProvider value={{ getRoom: () => null, PinTile }}>
      <BoardStage roomKey="channel:c1" callKey="call-5" pins={[]} roster={[]} cameras={[]} phase="connected" banner={<span data-test-banner />} />
    </StageHostProvider>
  );
  const m = await mount(stage);
  await act(async () => {});
  expect(m.container.querySelector("[data-test-pin]")?.getAttribute("data-test-pin")).toBe("doc:d1");
  expect(m.container.querySelector("[data-test-pin]")?.textContent).toBe("board");
  expect(m.container.querySelector("[data-test-banner]")).not.toBeNull();
  await act(() => m.root.unmount());
  // Back to board view in the same call: the board is known, nothing is pinned again.
  const again = await mount(stage);
  expect(again.container.querySelector("[data-test-pin]")?.getAttribute("data-test-pin")).toBe("doc:d1");
  expect(pinCallBoard).toHaveBeenCalledTimes(1);
  await act(() => again.root.unmount());
  useInboxStore.setState({ pinCallBoard: real } as any);
});

test("the header chip: nothing while absent; joining, listening; its menu removes Scribe", async () => {
  const remove = mock(() => {});
  const chip = (status: Status) => <ScribeChip scribe={scribeOf(status, undefined, remove)} session="s1" onOpenBoard={() => {}} onOpenSession={() => {}} />;
  const m = await mount(chip("absent"));
  expect(m.container.textContent).toBe("");
  await m.render(chip("joining"));
  expect(m.container.textContent).toContain("Scribe · joining");
  await m.render(chip("listening"));
  const trigger = m.container.querySelector("button")!;
  expect(trigger.textContent).toContain("Scribe · listening");
  await act(async () => void trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const item = [...document.querySelectorAll("[role=menuitem]")].find((e) => e.textContent?.includes("Remove from the call")) as HTMLElement;
  expect(item).toBeTruthy();
  await act(() => item.click());
  expect(remove).toHaveBeenCalledTimes(1);
  await act(() => m.root.unmount());
});

test("Settings → Calls writes each workspace's huddle settings under its own key", async () => {
  const m = await mount(<HuddlesSection />);
  expect(m.container.textContent).toContain("Huddles in");
  expect(m.container.textContent).toContain("One Scribe per call.");
  const switchOf = (label: string) => m.container.querySelector(`[aria-label='${label}']`) as HTMLButtonElement;
  expect(switchOf("Open huddles on the board").getAttribute("aria-checked")).toBe("false");
  await act(() => switchOf("Open huddles on the board").click());
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  const select = m.container.querySelector("select")!;
  await act(() => {
    select.value = "t2";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  expect(switchOf("Open huddles on the board").getAttribute("aria-checked")).toBe("false");
  await act(() => switchOf("Invite Scribe to every huddle").click());
  expect(ui().huddleAutoScribe).toEqual({ "team:t2": true });
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  await act(() => m.root.unmount());
});

test("the Add picker offers Scribe as its first row only when the caller can invite it", () => {
  const openPalette = mock((_opts: any) => {});
  const real = useInboxStore.getState().openPalette;
  useInboxStore.setState({ openPalette } as any);
  const onScribe = mock(() => {});
  const onPick = mock(() => {});
  openFeedTargetPicker({ title: "Add to the call", gesture: "feed", onScribe, onPick });
  const pick = openPalette.mock.calls[0][0].pick;
  expect(pick.extras[0]).toMatchObject({ key: "scribe", label: "Scribe", description: "Lays out the huddle on the board", lead: true });
  pick.onPick({ kind: "extra", key: "scribe" }, { query: "" });
  expect(onScribe).toHaveBeenCalledTimes(1);
  expect(onPick).not.toHaveBeenCalled();
  openFeedTargetPicker({ title: "Add to the call", gesture: "feed", onPick });
  expect(openPalette.mock.calls[1][0].pick.extras.some((x: any) => x.key === "scribe")).toBe(false);
  useInboxStore.setState({ openPalette: real } as any);
});
