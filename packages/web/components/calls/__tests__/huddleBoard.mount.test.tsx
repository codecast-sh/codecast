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
const startTranscribing = mock(async (_roomKey: string) => {});
const realCallManager = { ...(await import("../../../lib/calls/callManager")) };
mock.module("../../../lib/calls/callManager", () => ({ ...realCallManager, startTranscribing }));
const { BoardBanner, BoardStage, ScribeChip } = await import("../HuddleBoard");
const { boardBannerState } = await import("../../../lib/calls/huddleSettings");
const { HuddlesSection } = await import("../CallSettings");
const { openFeedTargetPicker } = await import("../useCallFeed");
const { StageHostProvider } = await import("../stageHost");
const { useBoardViewDefault } = await import("../../../hooks/useBoardViewDefault");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const WS = "team:t1";
type Status = "absent" | "joining" | "listening";
const scribeOf = (status: Status, invite = mock(async () => true), remove = mock(() => {})) => ({ present: status !== "absent", status, invite, remove });

beforeEach(() => {
  useInboxStore.setState((s: any) => ({ currentUser: { _id: "me" }, clientStateInitialized: true, clientState: { ...s.clientState, ui: { active_team_id: "t1" } }, teams: [{ _id: "t1", name: "Codecast" }, { _id: "t2", name: "Union" }] }));
});

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, root, render: (n: React.ReactNode) => act(() => root.render(n)) };
}
const ui = () => useInboxStore.getState().clientState.ui as any;
const review = () => document.querySelector("[data-switch-review]") as HTMLElement | null;
const reviewButton = (text: string) => [...review()!.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
const confirmReview = () => act(() => reviewButton("Invite to every huddle").click());
const button = (c: Element, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

test("which banner shows: invite while absent, Next time after this person invited, once per workspace", () => {
  const base = { boardViewOn: false, autoScribeOn: false, nextSeen: false };
  expect(boardBannerState({ ...base, present: false, memo: {} })).toBe("invite");
  expect(boardBannerState({ ...base, present: false, memo: { dismissed: true } })).toBeNull();
  // Somebody else's Scribe: no banner to save from.
  expect(boardBannerState({ ...base, present: true, memo: {} })).toBeNull();
  expect(boardBannerState({ ...base, present: true, memo: { invited: true }, boardViewOn: true })).toBe("next");
  expect(boardBannerState({ ...base, present: true, memo: { invited: true }, boardViewOn: true, autoScribeOn: true })).toBeNull();
  expect(boardBannerState({ ...base, present: true, memo: { invited: true, nextClosed: true } })).toBeNull();
  // Seen before in this workspace: never again, except through the call that first showed it.
  expect(boardBannerState({ ...base, present: true, memo: { invited: true }, nextSeen: true })).toBeNull();
  expect(boardBannerState({ ...base, present: true, memo: { invited: true, nextShown: true }, nextSeen: true })).toBe("next");
});

test("absent → Invite → Next time → Save writes both settings for that workspace only", async () => {
  const invite = mock(async () => true);
  const banner = (status: Status) => <BoardBanner callKey="call-1" workspace={WS} workspaceName="Codecast" scribe={scribeOf(status, invite)} />;
  const m = await mount(banner("absent"));
  expect(m.container.querySelector("[data-banner=invite]")?.textContent).toContain("Scribe can diagram your huddles as you talk");
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
  // "Invite Scribe" on starts an agent in every huddle: Save opens the review, and nothing is written until it is confirmed.
  await act(() => button(m.container, "Save")!.click());
  expect(review()?.getAttribute("data-switch-review")).toBe("Invite Scribe to every huddle");
  expect(review()!.textContent).toContain("Every huddle in Codecast");
  expect(review()!.textContent).toContain("Settings › Calls › Huddles");
  expect(ui().huddleAutoScribe).toBeUndefined();
  await confirmReview();
  expect(review()).toBeNull();
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  expect(ui().huddleAutoScribe).toEqual({ [WS]: true });
  expect(m.container.querySelector("[data-banner]")).toBeNull();
  await act(() => m.root.unmount());
});

test("an invite that did not seat Scribe brings no Next time, even when another Scribe arrives", async () => {
  const failed = mock(async () => false);
  const banner = (status: Status) => <BoardBanner callKey="call-7" workspace={WS} workspaceName="Codecast" scribe={scribeOf(status, failed)} />;
  const m = await mount(banner("absent"));
  await act(() => button(m.container, "Invite Scribe")!.click());
  expect(failed).toHaveBeenCalledTimes(1);
  await m.render(banner("absent"));
  expect(m.container.querySelector("[data-banner=invite]")).not.toBeNull();
  await m.render(banner("listening"));
  expect(m.container.querySelector("[data-banner]")).toBeNull();
  await act(() => m.root.unmount());
});

test("Next time with Invite Scribe unchecked saves on the press; backing out of the review saves nothing", async () => {
  const m = await mount(<BoardBanner callKey="call-6" workspace={WS} workspaceName="Codecast" scribe={scribeOf("absent")} />);
  await act(() => button(m.container, "Invite Scribe")!.click());
  await m.render(<BoardBanner callKey="call-6" workspace={WS} workspaceName="Codecast" scribe={scribeOf("joining")} />);
  await act(() => button(m.container, "Save")!.click());
  await act(() => reviewButton("Keep off").click());
  expect(review()).toBeNull();
  expect(ui().huddleAutoScribe).toBeUndefined();
  expect(m.container.querySelector("[data-banner=next]")).not.toBeNull();
  const boxes = [...m.container.querySelectorAll("[data-banner=next] input[type=checkbox]")] as HTMLInputElement[];
  await act(() => boxes[1].click());
  await act(() => button(m.container, "Save")!.click());
  expect(review()).toBeNull();
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  // Off was already off (absent): nothing to write.
  expect(ui().huddleAutoScribe).toBeUndefined();
  await act(() => m.root.unmount());
});

test("Next time shows once per person per workspace: shown, then gone for good there, whatever they did", async () => {
  const banner = (call: string, status: Status, ws = WS) => <BoardBanner callKey={call} workspace={ws} workspaceName="Codecast" scribe={scribeOf(status)} />;
  const inviteIn = async (m: Awaited<ReturnType<typeof mount>>, call: string, ws = WS) => {
    await m.render(banner(call, "absent", ws));
    await act(() => button(m.container, "Invite Scribe")!.click());
    await m.render(banner(call, "listening", ws));
  };
  const m = await mount(banner("seen-1", "absent"));
  await inviteIn(m, "seen-1");
  expect(m.container.querySelector("[data-banner=next]")).not.toBeNull();
  // Being shown is enough: recorded at once, for this workspace only.
  expect(ui().huddleNextTimeSeen).toEqual({ [WS]: true });
  // It stays up for the rest of that call, across a remount (switching views and back)…
  await act(() => m.root.unmount());
  const back = await mount(banner("seen-1", "listening"));
  expect(back.container.querySelector("[data-banner=next]")).not.toBeNull();
  // …and is never shown again in that workspace, though both settings are still off.
  await inviteIn(back, "seen-2");
  expect(back.container.querySelector("[data-banner]")).toBeNull();
  // Another workspace still gets its one showing.
  await inviteIn(back, "seen-3", "team:t2");
  expect(back.container.querySelector("[data-banner=next]")).not.toBeNull();
  expect(ui().huddleNextTimeSeen).toEqual({ [WS]: true, "team:t2": true });
  await act(() => back.root.unmount());
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

test("board view shows the call's board, got once per call, and pins nothing", async () => {
  const openCallBoard = mock(async () => ({ doc_id: "d1" }));
  const pinCallBoard = mock(async () => ({ doc_id: "d1" }));
  const pinToStage = mock(() => {});
  const real = useInboxStore.getState();
  useInboxStore.setState({ openCallBoard, pinCallBoard, pinToStage } as any);
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
  // Back to board view in the same call: the board is known, nothing is asked again.
  const again = await mount(stage);
  expect(again.container.querySelector("[data-test-pin]")?.getAttribute("data-test-pin")).toBe("doc:d1");
  expect(openCallBoard).toHaveBeenCalledTimes(1);
  expect(pinCallBoard).not.toHaveBeenCalled();
  expect(pinToStage).not.toHaveBeenCalled();
  await act(() => again.root.unmount());
  useInboxStore.setState({ openCallBoard: real.openCallBoard, pinCallBoard: real.pinCallBoard, pinToStage: real.pinToStage } as any);
});

test("board view opened before the call has a record asks again once it does", async () => {
  const openCallBoard = mock(async () => {
    throw new Error("The huddle has no call record yet: turn transcription on to give it a board");
  });
  const real = useInboxStore.getState().openCallBoard;
  useInboxStore.setState({ openCallBoard } as any);
  const PinTile = ({ share }: { share: any }) => <div data-test-pin={share.pin.ref} />;
  const stage = (callKey: string | null) => (
    <StageHostProvider value={{ getRoom: () => null, PinTile }}>
      <BoardStage roomKey="channel:late" callKey={callKey} pins={[]} roster={[]} cameras={[]} phase="connected" />
    </StageHostProvider>
  );
  const m = await mount(stage(null));
  await act(async () => {});
  expect(m.container.textContent).toContain("turn transcription on");
  // The error is no dead end: the action it names is right there.
  await act(() => (m.container.querySelector("[data-board-transcribe]") as HTMLButtonElement).click());
  expect(startTranscribing).toHaveBeenCalledWith("channel:late");
  // Transcription starts: the record appears, and the board opens without leaving the view.
  useInboxStore.setState({ openCallBoard: mock(async () => ({ doc_id: "d9" })) } as any);
  await m.render(stage("call-late"));
  await act(async () => {});
  expect(m.container.querySelector("[data-test-pin]")?.getAttribute("data-test-pin")).toBe("doc:d9");
  expect(m.container.textContent).not.toContain("turn transcription on");
  expect(m.container.querySelector("[data-board-transcribe]")).toBeNull();
  await act(() => m.root.unmount());
  useInboxStore.setState({ openCallBoard: real } as any);
});

test("Open huddles on the board waits for the settings to load before deciding", async () => {
  const toBoard = mock(() => {});
  function Probe({ ws, call = "channel:a" }: { ws: string | null; call?: string | null }) {
    useBoardViewDefault(call, ws, toBoard);
    return null;
  }
  // A cold reload into a live call: the workspace is known, the settings are not yet.
  useInboxStore.setState({ clientStateInitialized: false } as any);
  const m = await mount(<Probe ws={WS} />);
  expect(toBoard).not.toHaveBeenCalled();
  await act(() => {
    useInboxStore.setState((s: any) => ({ clientStateInitialized: true, clientState: { ...s.clientState, ui: { ...s.clientState.ui, huddleBoardView: { [WS]: true } } } }));
  });
  expect(toBoard).toHaveBeenCalledTimes(1);
  // Decided once: later changes leave the person's own view alone.
  await m.render(<Probe ws="team:t2" />);
  expect(toBoard).toHaveBeenCalledTimes(1);
  // The stage stays up into the next call: that call decides for itself.
  await m.render(<Probe ws={WS} call={null} />);
  await m.render(<Probe ws={WS} call="channel:b" />);
  expect(toBoard).toHaveBeenCalledTimes(2);
  await act(() => m.root.unmount());
  // Settings say no: the view stays.
  const off = mock(() => {});
  function ProbeOff() {
    useBoardViewDefault("channel:a", "team:t2", off);
    return null;
  }
  const n = await mount(<ProbeOff />);
  expect(off).not.toHaveBeenCalled();
  await act(() => n.root.unmount());
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
  // On goes through the review; off is one press.
  await act(() => switchOf("Invite Scribe to every huddle").click());
  expect(ui().huddleAutoScribe).toBeUndefined();
  expect(review()!.textContent).toContain("Every huddle in Union");
  await confirmReview();
  expect(ui().huddleAutoScribe).toEqual({ "team:t2": true });
  await act(() => switchOf("Invite Scribe to every huddle").click());
  expect(review()).toBeNull();
  expect(ui().huddleAutoScribe).toEqual({ "team:t2": false });
  expect(ui().huddleBoardView).toEqual({ [WS]: true });
  // Personal is a choice beside the teams: the person's own huddles, keyed to them.
  expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Personal", "Codecast", "Union"]);
  await act(() => {
    select.value = "personal";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(() => switchOf("Open huddles on the board").click());
  expect(ui().huddleBoardView).toEqual({ [WS]: true, "user:me": true });
  await act(() => switchOf("Invite Scribe to every huddle").click());
  expect(review()!.textContent).toContain("Every huddle in Personal");
  await confirmReview();
  expect(ui().huddleAutoScribe).toEqual({ "team:t2": false, "user:me": true });
  await act(() => m.root.unmount());
});

test("with no active team, Settings → Calls starts on Personal", async () => {
  useInboxStore.setState((s: any) => ({ clientState: { ...s.clientState, ui: {} } }));
  const m = await mount(<HuddlesSection />);
  expect((m.container.querySelector("select") as HTMLSelectElement).value).toBe("personal");
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
