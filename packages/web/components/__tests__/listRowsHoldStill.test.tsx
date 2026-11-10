// A row in a list holds still. One pulsing or pinging dot per running or
// pending session made the browser re-layer the whole page on every frame,
// keystrokes included, and the cost grew with the number of agents running.
// Rows show their state with a solid dot; only a single indicator (the open
// conversation's status, a section header) may move.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardStatusSignals } from "../inbox/SessionCardParts";
import { LivePulseDot } from "../SessionActivityLine";
import { LivenessDot } from "../LivenessDot";

const MOTION = /animate-(ping|pulse)/;

const row = (over: Record<string, unknown> = {}) => ({
  _id: "jx70000000000000000000000holdsti", title: "Row", agent_type: "claude_code", message_count: 4, updated_at: Date.now(), ...over,
}) as any;

const signals = (session: any, over: Record<string, boolean> = {}) =>
  renderToStaticMarkup(<CardStatusSignals session={session} showBlockedBadge={false} isWorking={false} isLive={false} dismissed={false} isPendingWorking={false} isRowRestarting={false} {...over} />);

test("a working card's dot holds still", () => {
  const html = signals(row(), { isWorking: true, isLive: true });
  expect(html).toContain("data-sv-working-dot");
  expect(html).not.toMatch(MOTION);
});

test("a card with a message pending holds still", () => {
  const html = signals(row({ has_pending: true }));
  expect(html).toContain("Message pending");
  expect(html).not.toMatch(MOTION);
});

test("the live dot holds still when a list row asks", () => {
  expect(renderToStaticMarkup(<LivePulseDot still />)).not.toMatch(MOTION);
  expect(renderToStaticMarkup(<LivePulseDot />)).toMatch(MOTION);
});

test("a card whose send is pending delivery, or that is restarting, holds still", () => {
  const pending = signals(row(), { isPendingWorking: true });
  expect(pending).toContain("pending");
  expect(pending).not.toMatch(MOTION);
  const restarting = signals(row(), { isRowRestarting: true });
  expect(restarting).toContain("restarting");
  expect(restarting).not.toMatch(MOTION);
});

test("a running liveness dot (board tiles, task rows) holds still", () => {
  expect(renderToStaticMarkup(<LivenessDot state="active" />)).not.toMatch(MOTION);
});

// The Modern style's rows (lib/sessionStatus): the card in every state, the
// marks, the section header, the board's tiles, the /sessions and /windows
// rows. Stricter than the Classic rule: no spinner either.
const STILL = /animate-(ping|pulse|spin|bounce)/;
const { MemoryRouter } = await import("react-router");
const { ModernSessionCardView } = await import("../inbox/ModernSessionCard");
const { SessionStatusMark, SessionStatusLabel } = await import("../inbox/SessionStatusMark");
const { ModernSectionHeader } = await import("../inbox/ModernSectionHeader");
const { ModernFleetBody } = await import("../fleet/ModernFleetBoard");
const { ModernSessionsRow } = await import("../../app/sessions/ModernSessionRow");
const { ModernWindowRow } = await import("../../app/windows/ModernWindowRow");
const { SESSION_STATUSES } = await import("../../lib/sessionStatus");
const { DEFAULT_IDENTITY_PREFS } = await import("../../lib/sessionIdentity");

const settled = (over: Record<string, unknown> = {}) => row({
  session_id: "s-hold", message_count: 8, is_idle: true, agent_status: "idle", is_connected: true,
  updated_at: Date.now() - 5 * 60_000, agent_status_updated_at: Date.now() - 5 * 60_000, started_at: Date.now() - 3_600_000, last_heartbeat: Date.now(),
  idle_summary: "Made the retry idempotent", worktree_name: "wt-1", cloud_placement: "pending", ...over,
});
const noop = () => {};
const modernCard = (session: any, props: Record<string, unknown> = {}, live: Record<string, unknown> = {}) => renderToStaticMarkup(
  <MemoryRouter>
    <ModernSessionCardView
      session={session}
      isActive={false}
      isFavorite={false}
      sessionLabel={null}
      now={Date.now()}
      chrome={{ showModelBadge: true, showAgentIcon: true, showBranchPill: true, prefs: DEFAULT_IDENTITY_PREFS }}
      liveness={{ isLive: false, pendingSend: false, restarting: false, draft: "", ...live }}
      viewerId={null}
      author={null}
      viewers={[]}
      spawnedByTitle={null}
      anchorIdentity={null}
      onSelect={noop}
      onPin={noop}
      onDismiss={noop}
      onStash={noop}
      {...props}
    />
  </MemoryRouter>,
);

test("a Modern card holds still in every state, mid-send, mid-restart and nested", () => {
  const aside = { onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined };
  const cards: Array<[string, string]> = [
    ["working", modernCard(settled({ is_idle: false, agent_status: "working" }), { variant: "working" }, { isLive: true })],
    ["needs_you", modernCard(settled(), { sectionStatus: "blocked" })],
    ["error", modernCard(settled({ pending_api_error: true, pending_api_error_kind: "limit" }), { sectionStatus: "blocked" })],
    ["starting", modernCard(settled({ message_count: 0, is_connected: false, started_at: Date.now(), updated_at: Date.now() }))],
    ["done", modernCard(settled(), { sectionStatus: "done" })],
    ["dormant", modernCard(settled(), { sectionStatus: "dormant" })],
    ["idle", modernCard(settled({ message_count: 0, started_at: Date.now() - 600_000, updated_at: Date.now() - 600_000 }))],
    ["stashed", modernCard(settled(), { variant: "stashed", ...aside })],
    ["killed", modernCard(settled(), { variant: "dismissed", ...aside })],
    // A send in flight: the section still decides the word, the line says "Sending".
    ["needs_you", modernCard(settled(), { sectionStatus: "blocked" }, { pendingSend: true })],
    ["working", modernCard(settled({ is_idle: false, agent_status: "working" }), { variant: "working" }, { restarting: true })],
    ["working", modernCard(settled({ is_subagent: true, parent_conversation_id: "p", is_idle: false, agent_status: "working" }), { variant: "working" }, { isLive: true })],
  ];
  const seen = new Set<string>();
  for (const [want, html] of cards) {
    const status = html.match(/data-mc-status="([a-z_]+)"/)?.[1];
    expect(status).toBe(want);
    seen.add(status!);
    expect(html).not.toMatch(STILL);
  }
  expect([...seen].sort()).toEqual([...SESSION_STATUSES].sort());
});

test("every status mark, the Modern section header, board tiles and the other Modern rows hold still", () => {
  for (const s of SESSION_STATUSES) {
    expect(renderToStaticMarkup(<SessionStatusMark status={s} />)).not.toMatch(STILL);
    expect(renderToStaticMarkup(<SessionStatusLabel status={s} />)).not.toMatch(STILL);
  }
  expect(renderToStaticMarkup(<ModernSectionHeader label="Working" count={3} color="text-sol-green" sectionKey="working" collapsed={false} />)).not.toMatch(STILL);
  const working = settled({ _id: "jx7000000000000000000000000000hw1", is_idle: false, agent_status: "working" });
  const asking = settled({ _id: "jx7000000000000000000000000000hw2", awaiting_input: true });
  const done = settled({ _id: "jx7000000000000000000000000000hw3", settle_verdict: "done" });
  const placed = { questions: [asking], pinned: [], needsInput: [], done: [done], dormant: [], working: [working], newSessions: [], placements: new Map() } as any;
  const board = renderToStaticMarkup(
    <MemoryRouter>
      <ModernFleetBody placed={placed} opts={{ queued: new Set(), pendingSendIds: new Set(), now: Date.now(), stopped: () => null }} onOpen={noop} />
    </MemoryRouter>,
  );
  expect(board.match(/data-session-tile=/g)).toHaveLength(3);
  expect(board).not.toMatch(STILL);
  const sessionsRow = renderToStaticMarkup(
    <MemoryRouter>
      <ModernSessionsRow
        row={{ _id: "m1", session_id: "s1", conversation_id: working._id, conversation_title: "Row", bucket: "active", awakeIdleMs: 0, lastActiveAt: Date.now(), lastActiveMs: 0, uptime: 60_000, pinned: false, dismissed: false, killed: false, isAlive: true }}
        inbox={working}
        now={Date.now()}
        busy={false}
        expanded={false}
        parking={false}
        onToggleExpand={noop}
        onPin={noop}
        onStash={noop}
        onKill={noop}
        onPrune={noop}
      />
    </MemoryRouter>,
  );
  expect(sessionsRow).toContain('data-mc-status="working"');
  expect(sessionsRow).not.toMatch(STILL);
  expect(renderToStaticMarkup(<ModernWindowRow session={working} now={Date.now()} onOpen={noop} />)).not.toMatch(STILL);
});
