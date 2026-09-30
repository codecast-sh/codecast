// The views the marketing hero renders from fixtures (heroFly/ARCHITECTURE.md
// section 3, items 11, 12 and 14). Each was split out of a container or given
// a seam; these pin that the view draws from its props alone and that the seam
// keeps the real store, toasts and window out of it.
// Run: bun test components/__tests__/heroViewSplits.mount.test.tsx
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { useInboxStore } from "../../store/inboxStore";
import { NotificationList } from "../notifications/NotificationList";
import { HorizonRail } from "../triggers/HorizonRail";
import { TriggerRowItem } from "../TriggerRow";
import { TriggerPill, SingleHeader } from "../TriggerContextPanel";
import { PageCard, PageFavicon, PublishedPageActions } from "../PublishedPageEmbed";
import { ChatLine, EventLine, PassageBlock, RecapCard } from "../calls/RoomThreadRows";
import { buildPassages } from "../calls/roomThreadModel";
import { FaceRow } from "../faces/FaceRow";
import { deriveFaceRow, type FaceRowInput } from "../../lib/faces/faceRow";
import type { TaskRow } from "../triggerTasks";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

async function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const NOW = Date.now();
const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  _id: "hero-t1",
  short_id: "tr-1",
  title: "Nightly dependency audit",
  prompt: "Audit the lockfile",
  status: "scheduled",
  schedule_type: "recurring",
  interval_ms: 6 * 3600_000,
  run_at: NOW + 40 * 60_000,
  run_count: 3,
  created_at: NOW - 86_400_000,
  last_run_at: NOW - 2 * 3600_000,
  last_run_summary: "No new advisories",
  ...over,
});

describe("NotificationList", () => {
  const notes = [
    { _id: "n1", type: "permission_request", message: "npm test", created_at: NOW - 5_000, read: false },
    { _id: "n2", type: "session_idle", message: "Auth refactor is waiting", created_at: NOW - 60_000, read: true },
  ];

  test("floating keeps the bell's exact panel classes; in place drops only the placement", () => {
    const floating = renderToStaticMarkup(
      <NotificationList notifications={notes} unreadCount={1} onOpen={() => {}} onViewAll={() => {}} />,
    );
    expect(floating).toContain(
      'class="cc-topbar-menu absolute right-0 mt-2 w-[calc(100vw-1rem)] sm:w-[520px] max-w-[520px] bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden z-50"',
    );
    expect(floating).toContain("1 unread");
    expect(floating).toContain("npm test");
    const inPlace = renderToStaticMarkup(
      <NotificationList notifications={notes} unreadCount={1} onOpen={() => {}} onViewAll={() => {}} floating={false} className="w-full" />,
    );
    expect(inPlace).toContain('class="bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden w-full"');
  });

  test("rows open through the prop, and View all is the caller's", async () => {
    const opened: string[] = [];
    let viewAll = 0;
    const m = await mount(
      <NotificationList notifications={notes} unreadCount={1} onOpen={(n) => opened.push(n._id)} onViewAll={() => viewAll++} floating={false} />,
    );
    const viewAllBtn = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "View all")!;
    await act(async () => viewAllBtn.click());
    expect(viewAll).toBe(1);
    await m.unmount();
  });

  test("empty says so", () => {
    expect(renderToStaticMarkup(<NotificationList notifications={[]} unreadCount={0} onOpen={() => {}} onViewAll={() => {}} />)).toContain(
      "No notifications yet",
    );
  });
});

describe("HorizonRail", () => {
  test("draws past, next and ghost points and hands a past dot to its caller", async () => {
    const opened: string[] = [];
    const t = task();
    const m = await mount(<HorizonRail tasks={[t]} now={NOW} onOpenPastRun={(x) => opened.push(x._id)} />);
    const past = m.container.querySelector('button[aria-label^="Open run"]') as HTMLButtonElement;
    expect(past).toBeTruthy();
    await act(async () => past.click());
    expect(opened).toEqual(["hero-t1"]);
    expect(m.container.textContent).toContain("+24h");
    await m.unmount();
  });

  test("renders nothing with nothing on the axis", () => {
    expect(renderToStaticMarkup(<HorizonRail tasks={[]} now={NOW} onOpenPastRun={() => {}} />)).toBe("");
  });
});

describe("TriggerRowItem actions override", () => {
  test("every verb goes to the override: no store action, no server toast", async () => {
    const storeAction = spyOn(useInboxStore.getState(), "triggerAction");
    useInboxStore.setState({ triggerAction: storeAction } as any);
    const toastSuccess = spyOn(toast, "success");
    const calls: string[] = [];
    const m = await mount(
      <TriggerRowItem row={{ task: task(), unread: false }} variant="page" onOpen={() => {}} actions={(id, verb) => calls.push(`${id}:${verb}`)} />,
    );
    for (const label of ["Run now", "Pause"]) {
      const btn = m.container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      await act(async () => btn.click());
    }
    expect(calls).toEqual(["hero-t1:runNow", "hero-t1:pause"]);
    expect(storeAction).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    toastSuccess.mockRestore();
    storeAction.mockRestore();
    await m.unmount();
  });
});

describe("Trigger strip pieces", () => {
  test("TriggerPill and SingleHeader draw a fixture task", () => {
    const pill = renderToStaticMarkup(<TriggerPill task={task()} now={NOW} active onClick={() => {}} />);
    expect(pill).toContain("Nightly dependency audit");
    expect(pill).toContain('aria-pressed="true"');
    const head = renderToStaticMarkup(
      <MemoryRouter>
        <SingleHeader task={task()} isLoop={false} expanded={false} now={NOW} conversationId="hero-c1" onToggle={() => {}} />
      </MemoryRouter>,
    );
    expect(head).toContain("Nightly dependency audit");
    expect(head).toContain("next");
  });
});

describe("PageCard", () => {
  test("the published page card, with the embed's own verbs", () => {
    const html = renderToStaticMarkup(
      <PageCard
        icon={<PageFavicon className="h-4 w-4" />}
        title="Q3 funnel report"
        href="https://codecast.sh/a/hero-report"
        caption="Built from the canvas"
        actions={<PublishedPageActions slug="hero-report" expanded={false} onToggleExpand={() => {}} />}
      >
        <iframe title="Q3 funnel report" srcDoc="<p>hi</p>" />
      </PageCard>,
    );
    expect(html).toContain("Q3 funnel report");
    expect(html).toContain("Copy link to published page");
    expect(html).toContain('title="Expand"');
    expect(html).toContain("Built from the canvas");
  });
});

describe("RoomThread rows", () => {
  test("recap, passage, event and chat line render from plain rows", () => {
    const recap = renderToStaticMarkup(<RecapCard summary="We picked the webhook design. Ann owns it." items={["Ship the API half"]} live />);
    expect(recap).toContain("So far");
    expect(recap).toContain("We picked the webhook design.");

    const [first] = buildPassages([
      { seq: 0, speaker_id: "u-ann", speaker_name: "Ann", text: "Let us split it", t0: 0, t1: 5_000, at: NOW - 60_000 },
      { seq: 1, speaker_id: "u-bob", speaker_name: "Bob", text: "API half is mine", t0: 6_000, t1: 12_000, at: NOW - 54_000 },
    ]);
    const passage = renderToStaticMarkup(
      <PassageBlock
        passage={first}
        idPrefix="hero"
        open
        live
        fresh={false}
        recording={false}
        dayOf={NOW}
        onToggle={() => {}}
      />,
    );
    expect(passage).toContain("Ann");
    expect(passage).toContain("API half is mine");

    const event = renderToStaticMarkup(
      <EventLine
        row={{ _id: "hero-e1", event: "agent_joined", at: NOW, user_id: "u-ann", user_name: "Ann", text: "", mine: false, agent: { conversation_id: "hero-c1", title: "Webhook API", name: "Otter" } } as any}
        me="u-me"
        ownRoomId={null}
        ended={false}
        explain
        fresh={false}
        dayOf={NOW}
        onOpen={() => {}}
      />,
    );
    expect(event).toContain("Ann added");
    expect(event).toContain("Otter");

    const line = renderToStaticMarkup(
      <MemoryRouter>
        <ChatLine m={{ _id: "hero-m1", user_id: "u-ann", at: NOW, user_name: "Ann Lee", text: "Ship it", mine: false, agent: null }} sameAuthor={false} fresh={false} dayOf={NOW} stage onOpen={() => {}} />
      </MemoryRouter>,
    );
    expect(line).toContain("Ann");
    expect(line).toContain("Ship it");
  });
});

describe("FaceRow at rest", () => {
  test("a fixture row mounts without window pointerdown or keydown listeners", async () => {
    const input: FaceRowInput = {
      viewer: { id: "hero-me", name: "Me" },
      roster: [
        { _id: "hero-me", name: "Me", presence_state: "active" },
        { _id: "hero-ann", name: "Ann", presence_state: "active" },
        { _id: "hero-bob", name: "Bob", presence_state: "idle" },
      ] as any,
      occupancy: {},
      liveRooms: [],
      walkie: { liveRoom: null, sending: null, incoming: null, canReply: false },
      call: { phase: "idle", roomKey: null, muted: true, micDenied: false, camera: false, speaking: [], cameras: [] },
      followLeaderId: null,
      rings: { incoming: [], outgoing: [] },
      announcement: null,
      unread: new Map(),
      ask: new Map(),
      now: NOW,
    };
    const row = deriveFaceRow(input, null);
    expect(row.entries.length).toBe(3);
    const added: string[] = [];
    const spy = spyOn(window, "addEventListener").mockImplementation(((type: string) => added.push(type)) as any);
    const m = await mount(<FaceRow row={row} density="bar" viewerId="hero-me" callsEnabled={false} />);
    spy.mockRestore();
    expect(m.container.querySelectorAll("[data-face-id]").length).toBe(3);
    expect(added.filter((t) => t === "pointerdown" || t === "keydown")).toEqual([]);
    await m.unmount();
  });
});
