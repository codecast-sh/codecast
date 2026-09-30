"use client";

/**
 * The fly-through's world: one render function per surface, composed from the
 * productMocks pieces. Every element the timeline animates carries
 * `data-fly="<surface>/<id>"` and typed text carries `data-fly-text`. Initial
 * inline styles come from `frame(POSTER_T)`, so the prerender is the poster
 * frame with real text and hydration matches it exactly.
 */

import { memo, type CSSProperties, type ReactNode } from "react";
import {
  AgentChip,
  ArrowUpIcon,
  AssigneeSlot,
  Avatar,
  BotIcon,
  CanvasCard,
  CheckCircleIcon,
  CircleDotIcon,
  CircleIcon,
  Composer,
  ConversationHeader,
  HERO_SESSIONS,
  HeroSidebar,
  MessageSquareIcon,
  ParentLink,
  PhoneFrame,
  PlanPill,
  SessionMessageCard,
  SessionPill,
  SessionRow,
  StatusDot,
  TASK_ROWS,
  TaskPill,
  TaskRow,
  TaskToolbar,
  UserPromptCard,
  WindowChrome,
  type HeroSession,
} from "../productMocks";
import { frame } from "./timeline";
import { ARC, DESK, DESK_ROWS, FLYERS, LABEL_3W, POSTER_T, SURFACES, type Surface, type SurfaceId } from "./world";

const F0 = frame(POSTER_T);

/** Props that register an element with the driver, seeded with its poster-frame style. */
export function fly(id: string, style?: CSSProperties) {
  const e = F0.els[id];
  const s: CSSProperties = { ...style };
  if (e?.transform !== undefined) s.transform = e.transform;
  if (e?.opacity !== undefined) s.opacity = e.opacity;
  if (e?.visible !== undefined) s.visibility = e.visible ? "visible" : "hidden";
  return { "data-fly": id, style: s };
}

function Typed({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <span data-fly-text={id} className={className} style={style}>
      {F0.texts[id]}
    </span>
  );
}

const INK = "#002b36";
const DIM = "#93a1a1";
const BODY = "#657b83";

/* ── Desk: the desktop app ────────────────────────────────────────────── */

const WORKER_A: HeroSession = { status: "working", title: "Webhook API half", note: "Reading stripe/webhooks.ts", agent: "codex", time: "now" };
const WORKER_B: HeroSession = { status: "working", title: "Dashboard retry UI", note: "Applying retry states to the table", agent: "cursor", time: "now" };
const MIGRATE: HeroSession = { status: "working", title: "Migrate billing webhooks", note: "Reading the webhook handlers", agent: "claude", time: "now" };
const [, DASH, FLAKY, DARK, P95, CACHE, RATE] = HERO_SESSIONS;
const ROW_DATA: Record<(typeof DESK_ROWS)[number]["key"], HeroSession> = {
  migrate: MIGRATE, workerA: WORKER_A, workerB: WORKER_B, dash: DASH, flaky: FLAKY, dark: DARK, p95: P95, cache: CACHE, rate: RATE,
};

const HIGHLIGHT: CSSProperties = { backgroundColor: "rgba(181,137,0,0.08)", borderLeft: "2px solid #b58900" };

function Chip({ id, agent }: { id: string; agent: string }) {
  return (
    <span {...fly(`desk/chip:${id}`, { display: "inline-block" })}>
      <AgentChip agent={agent} />
    </span>
  );
}

function WorkerADot() {
  return (
    <span {...fly("desk/dotWrap:workerA", { position: "relative", display: "inline-flex" })}>
      <StatusDot kind="working" />
      <span {...fly("desk/dotAmber:workerA", { position: "absolute", inset: 0, display: "inline-flex" })}>
        <StatusDot kind="needs-input" />
      </span>
      <span
        {...fly("desk/ring:workerA", { position: "absolute", left: -10, top: -10, width: 28, height: 28, borderRadius: 999, border: "1.5px solid #b58900" })}
      />
    </span>
  );
}

function WorkerANote() {
  const layer: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", textOverflow: "ellipsis" };
  return (
    <>
      <span {...fly("desk/note1:workerA")}>{WORKER_A.note}</span>
      <span {...fly("desk/note2:workerA", { ...layer, color: "#b58900" })}>Allow running npm test?</span>
      <span {...fly("desk/note3:workerA", { ...layer, color: "#859900" })}>Running npm test. 212 passed</span>
    </>
  );
}

function DeskRow({ k }: { k: (typeof DESK_ROWS)[number]["key"] }) {
  const s = ROW_DATA[k];
  const row = DESK_ROWS.find((r) => r.key === k)!;
  const worker = k === "workerA" || k === "workerB";
  return (
    <div {...fly(`desk/row:${k}`, { height: row.h, position: "relative" })}>
      {(k === "dash" || k === "migrate") && <div {...fly(`desk/hl:${k}`, { position: "absolute", inset: 0, ...HIGHLIGHT })} />}
      <SessionRow
        s={s}
        className="relative h-full justify-center"
        dot={k === "workerA" ? <WorkerADot /> : undefined}
        note={k === "workerA" ? <WorkerANote /> : undefined}
        chip={<Chip id={k} agent={s.agent} />}
        parent={worker ? <ParentLink title="Migrate billing webhooks" /> : undefined}
      />
    </div>
  );
}

function ToolBlock({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div {...fly(`desk/${id}`, { height: 30, backgroundColor: "#eee8d5", color: "#586e75" })} className="flex items-center rounded px-2.5 text-[11px]">
      <span style={{ color: "#859900" }}>$</span>&nbsp;{children}
    </div>
  );
}

function DeskSurface() {
  return (
    <div className="flex h-full flex-col font-mono text-left" style={{ backgroundColor: "#fdf6e3" }}>
      <div style={{ height: DESK.chrome }}>
        <WindowChrome title="Search conversations…  ⌘K" />
      </div>
      <div className="flex min-h-0 flex-1">
        <HeroSidebar badge={<Typed id="desk/badge" />} badgeProps={fly("desk/badge")} />
        <div className="relative shrink-0 overflow-hidden pt-2" style={{ width: DESK.list, borderRight: "1px solid #eee8d5" }}>
          {DESK_ROWS.map((r) => <DeskRow key={r.key} k={r.key} />)}
        </div>
        <div className="relative min-w-0 flex-1">
          <div {...fly("desk/conv:dash", { position: "absolute", inset: 0 })} className="flex flex-col">
            <ConversationHeader title="Dashboard rewrite" status="working" agent="claude" initials="S" avatarColor="#2aa198" />
            <div className="flex flex-1 flex-col gap-3 px-5 py-4 text-[12px]" style={{ color: BODY }}>
              <UserLine />
              <div className="leading-relaxed">Table states are done. Wiring retries next.</div>
              <Composer className="mt-auto" />
            </div>
          </div>
          <div {...fly("desk/conv:migrate", { position: "absolute", inset: 0 })} className="flex flex-col">
            <ConversationHeader title="Migrate billing webhooks" status="working" agent="claude" initials="A" avatarColor="#cb4b16" />
            <div className="flex flex-1 flex-col gap-2 px-5 py-4 text-[12px]" style={{ color: BODY }}>
              <div {...fly("desk/prompt")} className="mb-1">
                <UserPromptCardInline />
              </div>
              <div className="min-h-[20px] leading-relaxed">
                <Typed id="desk/prose1" />
              </div>
              <ToolBlock id="spawnA">cast spawn --subagent --agent codex &quot;Webhook API half&quot;</ToolBlock>
              <ToolBlock id="spawnB">cast spawn --subagent --agent cursor &quot;Dashboard retry UI&quot;</ToolBlock>
              <div {...fly("desk/prose2")} className="mt-1 leading-relaxed">
                Both halves are merged. Filed{" "}
                <span {...fly("desk/taskpill", { display: "inline-block" })}>
                  <TaskPill title="Retry queue for failed webhooks" />
                </span>{" "}
                for the last two endpoints.
              </div>
              <Composer className="mt-auto" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserLine() {
  return (
    <UserPromptCard name="Sarah" initials="S" color="#2aa198">
      make the failed rows retryable from the table
    </UserPromptCard>
  );
}

function UserPromptCardInline() {
  return (
    <UserPromptCard>
      switch us to the new Stripe webhook API. <span style={{ color: "#6c71c4" }}>@sarah</span> owns the dashboard side
    </UserPromptCard>
  );
}

/* ── Phone: the iOS app ───────────────────────────────────────────────── */

const PHONE_ROWS = [
  { status: "working" as const, title: "Migrate billing webhooks", agent: "claude" },
  { status: "needs-input" as const, title: "Webhook API half", agent: "codex" },
  { status: "working" as const, title: "Dashboard retry UI", agent: "cursor" },
  { status: "working" as const, title: "Fix flaky auth test", agent: "codex" },
  { status: "working" as const, title: "Ship dark mode", agent: "cursor" },
  { status: "needs-input" as const, title: "Refactor session cache", agent: "pi" },
];

function CodecastGlyph({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[6px] font-bold text-[#fdf6e3]" style={{ width: size, height: size, backgroundColor: INK, fontSize: size * 0.5 }}>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="#b58900" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M7 7l6 5-6 5M14 17h4" /></svg>
    </span>
  );
}

function PhoneSurface() {
  const cmd = "npm test --workspace packages/api";
  return (
    <PhoneFrame className="h-full !shadow-none" screenClassName="relative h-[calc(100%-0px)]">
      <div className="relative font-mono text-left" style={{ height: 572 }}>
        <div {...fly("phone/inbox", { position: "absolute", inset: 0 })} className="px-4 pt-1">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[17px] font-semibold text-[#eee8d5]">Inbox</span>
            <span className="rounded-full px-2 text-[10px] text-white" style={{ backgroundColor: "#b58900" }}>2</span>
          </div>
          {PHONE_ROWS.map((r) => (
            <div key={r.title} className="flex items-center gap-2 py-2.5 text-[12px]" style={{ borderBottom: "1px solid #073642" }}>
              <StatusDot kind={r.status} />
              <span className="min-w-0 flex-1 truncate text-[#eee8d5]">{r.title}</span>
              <AgentChip agent={r.agent} />
            </div>
          ))}
        </div>

        <div {...fly("phone/session", { position: "absolute", inset: 0 })} className="flex flex-col px-4 pt-1">
          <div className="mb-1 flex items-center gap-2 text-[#eee8d5]">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="#268bd2" strokeWidth={2.5}><path d="M15 18l-6-6 6-6" /></svg>
            <span className="text-[14px] font-semibold">Webhook API half</span>
          </div>
          <div className="relative mb-3 h-4 pl-6 text-[10px]">
            <span {...fly("phone/hdrAmber", { position: "absolute", left: 24, display: "inline-flex", alignItems: "center", gap: 6, color: "#b58900" })}>
              <StatusDot kind="needs-input" /> Needs input · codex
            </span>
            <span {...fly("phone/hdrGreen", { position: "absolute", left: 24, display: "inline-flex", alignItems: "center", gap: 6, color: "#859900" })}>
              <StatusDot kind="working" /> Working · codex
            </span>
          </div>
          <div className="mb-3 text-[11px] leading-relaxed text-[#93a1a1]">Handlers are on the new API. Running the suite before I push.</div>
          <div className="rounded-lg p-3" style={{ backgroundColor: "rgba(181,137,0,0.12)", border: "1px solid rgba(181,137,0,0.45)" }}>
            <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold" style={{ color: "#b58900" }}>
              <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] text-[#002b36]" style={{ backgroundColor: "#b58900" }}>!</span>
              Permission Required
            </div>
            <div className="mb-1 text-[11px] text-[#eee8d5]">Bash</div>
            <div className="mb-3 rounded px-2 py-1.5 text-[10.5px] text-[#eee8d5]" style={{ backgroundColor: "rgba(0,0,0,0.3)" }}>{cmd}</div>
            <div className="flex gap-2 text-[12px] font-semibold">
              <span className="relative flex-1">
                <span {...fly("phone/approve", { position: "relative", display: "block", backgroundColor: "#859900", color: "#fdf6e3" })} className="rounded-md py-1.5 text-center">
                  <span {...fly("phone/approveLabel")}>Approve</span>
                  <span {...fly("phone/approved", { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" })}>Approved</span>
                </span>
                <span {...fly("phone/tapRing", { position: "absolute", left: "50%", top: "50%", width: 28, height: 28, marginLeft: -14, marginTop: -14, borderRadius: 999, backgroundColor: "#fdf6e3" })} />
              </span>
              <span {...fly("phone/deny", { flex: 1, border: "1px solid #dc322f", color: "#dc322f" })} className="rounded-md py-1.5 text-center">Deny</span>
            </div>
          </div>
          <div {...fly("phone/passed")} className="mt-3 text-[11px]" style={{ color: "#859900" }}>
            ✓ 212 passed, 0 failed
          </div>
          <div className="mt-auto mb-3 rounded-lg px-3 py-2 text-[11px] text-[#586e75]" style={{ backgroundColor: "#073642" }}>Send a message...</div>
        </div>

        <div {...fly("phone/banner", { position: "absolute", left: 8, right: 8, top: 4 })}>
          <div className="rounded-2xl px-3 py-2.5 text-left" style={{ backgroundColor: "rgba(253,246,227,0.97)", boxShadow: "0 10px 30px -12px rgba(0,0,0,0.6)" }}>
            <div className="mb-1 flex items-center gap-2 text-[10px]" style={{ color: DIM }}>
              <CodecastGlyph size={18} />
              <span className="uppercase tracking-wide">codecast</span>
              <span className="ml-auto">now</span>
            </div>
            <div className="text-[12px] font-semibold" style={{ color: INK }}>Permission needed</div>
            <div className="text-[11px]" style={{ color: BODY }}>Webhook API half</div>
            <div className="mt-0.5 truncate text-[11px]" style={{ color: INK }}>{cmd}</div>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

/* ── Pair: two worker sessions talking ────────────────────────────────── */

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden font-mono text-left" style={{ backgroundColor: "#fdf6e3" }}>
      {children}
    </div>
  );
}

function PairASurface() {
  return (
    <Card>
      <ConversationHeader title="Webhook API half" status="working" agent="codex" initials="A" avatarColor="#cb4b16" />
      <div className="flex flex-1 flex-col gap-2.5 px-5 py-3.5 text-[12px]" style={{ color: BODY }}>
        <ParentLink title="Migrate billing webhooks" />
        <div className="leading-relaxed">Handlers are on the new API and deployed to staging. 212 tests pass.</div>
        <div {...fly("pairA/cmdA", { backgroundColor: "#eee8d5", color: "#586e75", minHeight: 28 })} className="rounded px-2.5 py-1.5 text-[11px]">
          <span style={{ color: "#859900" }}>$</span> <Typed id="pairA/cmdA" />
        </div>
        <div {...fly("pairA/backMsg")}>
          <SessionMessageCard from="Dashboard retry UI" age="now">staging green on my end</SessionMessageCard>
        </div>
      </div>
    </Card>
  );
}

function PairBSurface() {
  return (
    <Card>
      <div className="flex items-center" style={{ borderBottom: "1px solid #eee8d5" }}>
        <div className="min-w-0 flex-1 [&>div]:border-0">
          <ConversationHeader title="Dashboard retry UI" status="working" agent="cursor" initials="S" avatarColor="#2aa198" />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 px-5 py-3.5 text-[12px]" style={{ color: BODY }}>
        <div className="flex items-center gap-2">
          <ParentLink title="Migrate billing webhooks" />
          <span className="ml-auto rounded px-1.5 text-[10px]" style={{ backgroundColor: "#eee8d5", color: DIM }}>jx7k2mq</span>
        </div>
        <div className="leading-relaxed">Retry states are wired into the table. Waiting on the API half.</div>
        <div {...fly("pairB/msgCard")}>
          <SessionMessageCard from="Webhook API half" age="now" size="md">api is on staging, your turn</SessionMessageCard>
        </div>
        <div className="min-h-[20px] leading-relaxed" style={{ color: INK }}>
          <Typed id="pairB/replyB" />
        </div>
      </div>
    </Card>
  );
}

/* ── Board: the task tracker ──────────────────────────────────────────── */

const stack: CSSProperties = { position: "absolute", inset: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" };

function BoardSurface() {
  const [first, ...rest] = TASK_ROWS;
  const firstRow = {
    ...first,
    icon: (
      <span {...fly("board/done0:check", { position: "relative", display: "inline-flex", width: 16, height: 16 })}>
        <span {...fly("board/done0:iconOld", stack)}>{first.icon}</span>
        <span {...fly("board/done0:icon", stack)}><CheckCircleIcon color="#859900" /></span>
      </span>
    ),
    title: (
      <span className="relative">
        <span {...fly("board/done0:titleOld")}>{first.title}</span>
        <span {...fly("board/done0:title", { position: "absolute", left: 0, top: 0, color: DIM, whiteSpace: "nowrap" })}>{first.title}</span>
      </span>
    ),
  };
  const newRow = {
    icon: (
      <span className="relative inline-flex h-4 w-4">
        <span {...fly("board/status:open", stack)}><CircleIcon color="#268bd2" /></span>
        <span {...fly("board/status:doing", stack)}><CircleDotIcon color="#b58900" /></span>
      </span>
    ),
    id: "ct-731",
    title: (
      <>
        Retry queue for failed webhooks
        <span {...fly("board/claimed", { display: "inline-block", marginLeft: 10, fontSize: 10, color: "#859900" })}>codex claimed</span>
      </>
    ),
    pill: <PlanPill name="Billing" />,
    dots: [] as string[],
    who: null,
    pri: <ArrowUpIcon color="#cb4b16" />,
    age: "now",
  };
  const face: CSSProperties = { position: "absolute", inset: 0, backfaceVisibility: "hidden" };
  return (
    <div className="flex h-full flex-col overflow-hidden font-mono text-left" style={{ backgroundColor: "#FBF5E2" }}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]" style={{ borderBottom: "1px solid rgba(147,161,161,0.15)" }}>
        <span className="font-semibold" style={{ color: INK }}>Tasks</span>
        <span style={{ color: DIM }}>codecast</span>
        <span className="ml-auto text-[10px]" style={{ color: DIM }}>6 open · 3 claimed by agents</span>
      </div>
      <TaskToolbar />
      <div className="relative py-0.5">
        <div {...fly("board/newRow", { transformOrigin: "0 50%", backgroundColor: "rgba(38,139,210,0.06)" })}>
          <div {...fly("board/newRowBody")}>
            <TaskRow
              r={newRow}
              whoSlot={
                <span className="relative h-5 w-5 shrink-0">
                  <span {...fly("board/who:empty", face)}>
                    <AssigneeSlot style={{ backgroundColor: "transparent", border: "1px dashed #93a1a1" }} />
                  </span>
                  <span {...fly("board/who:codex", face)}>
                    <AssigneeSlot><BotIcon color="#859900" /></AssigneeSlot>
                  </span>
                </span>
              }
            />
          </div>
        </div>
        {[firstRow, ...rest].map((r, i) => (
          <div key={r.id} {...fly(`board/task:${i}`)}>
            <TaskRow r={r} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Palette: search across every session ─────────────────────────────── */

function Key({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[9px]" style={{ backgroundColor: "#eee8d5", color: BODY, border: "1px solid #e4ddc8", borderBottomWidth: 2 }}>
      {children}
    </span>
  );
}

function PaletteSurface() {
  const hit = (s: string) => <span style={{ color: "#b58900", backgroundColor: "rgba(181,137,0,0.12)" }}>{s}</span>;
  return (
    <div className="flex h-full flex-col overflow-hidden font-mono text-left" style={{ backgroundColor: "#fdf6e3" }}>
      <div className="flex items-center gap-3 px-5" style={{ height: 58, borderBottom: "1px solid #eee8d5" }}>
        <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke={DIM}><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
        <span className="relative min-w-0 flex-1 text-[16px]" style={{ color: INK }}>
          <span {...fly("palette/placeholder", { position: "absolute", left: 0, color: DIM })}>Search sessions, docs...</span>
          <Typed id="palette/query" />
          <span className="ml-px inline-block h-[18px] w-[2px] align-middle" style={{ backgroundColor: "#268bd2" }} />
        </span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: DIM }}>
          <Avatar initials="S" color="#2aa198" /> sarah
        </span>
      </div>
      <div className="flex-1 px-2 py-2 text-[12px]">
        <div {...fly("palette/group:sessions")} className="px-3 pb-1 pt-1 text-[10px] uppercase tracking-wider" style={{ color: DIM }}>Sessions</div>
        <div {...fly("palette/res:0", { position: "relative" })} className="rounded-md">
          <div {...fly("palette/sel", { position: "absolute", inset: 0, borderRadius: 6, ...HIGHLIGHT })} />
          <div className="relative flex items-center gap-2.5 px-3 py-2.5">
            <MessageSquareIcon color="#268bd2" />
            <span style={{ color: INK }}>Migrate billing webhooks</span>
            <span className="ml-auto flex items-center gap-2 text-[10px]" style={{ color: DIM }}><AgentChip agent="claude" /> · Ashot · 3w</span>
          </div>
        </div>
        <div {...fly("palette/res:1")} className="rounded-md px-3 py-2">
          <div className="flex items-center gap-2.5">
            <MessageSquareIcon color="#268bd2" />
            <span style={{ color: INK }}>Webhook API half</span>
            <span className="ml-auto flex items-center gap-2 text-[10px]" style={{ color: DIM }}><AgentChip agent="codex" /> · 3w</span>
          </div>
          <div className="mt-1 pl-[22px] text-[11px]" style={{ color: BODY }}>
            MAX_ATTEMPTS = 2, then park it in the {hit("retry")} queue
          </div>
        </div>
        <div {...fly("palette/group:tasks")} className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider" style={{ color: DIM }}>Tasks</div>
        <div {...fly("palette/res:2")} className="flex items-center gap-2.5 rounded-md px-3 py-2">
          <CheckCircleIcon color="#859900" />
          <span className="text-[11px]" style={{ color: BODY }}>ct-731</span>
          <span style={{ color: INK }}>{hit("Retry")} queue for failed {hit("webhooks")}</span>
          <span className="ml-auto flex items-center gap-2 text-[10px]" style={{ color: DIM }}>done · <AgentChip agent="codex" /></span>
        </div>
      </div>
      <div className="flex items-center gap-4 px-5 py-2 text-[10px]" style={{ borderTop: "1px solid #eee8d5", color: DIM }}>
        <span className="flex items-center gap-1"><Key>↑</Key><Key>↓</Key> navigate</span>
        <span className="flex items-center gap-1"><Key>↵</Key> open</span>
        <span className="flex items-center gap-1"><Key>esc</Key> close</span>
      </div>
    </div>
  );
}

/* ── Blame: a line of code traced to its conversation ─────────────────── */

const BLAME_LINES = [
  { sha: "a41c9e2", who: "jx7p4rt Ashot Webhook API half", date: "2026-09-09 10:14:02 -0700 41", code: "const MAX_ATTEMPTS = 2;", session: true },
  { sha: "a41c9e2", who: "jx7p4rt Ashot Webhook API half", date: "2026-09-09 10:14:02 -0700 42", code: "await retryQueue.park(event);", session: true },
  { sha: "9f03b17", who: "Sarah Chen                    ", date: "2026-09-12 16:40:51 -0700 43", code: "// batch 2 on the new endpoint", session: false },
];

function BlameSurface() {
  return (
    <div className="flex h-full flex-col overflow-hidden font-mono text-left" style={{ backgroundColor: INK, color: "#93a1a1" }}>
      <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: "#073642" }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#dc322f" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#b58900" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#859900" }} />
        <span className="mx-auto text-[11px]" style={{ color: "#586e75" }}>zsh · ~/src/api</span>
      </div>
      <div className="flex-1 px-4 py-3 text-[10.5px] leading-[1.9]">
        <div className="mb-1 text-[12px]" style={{ color: "#eee8d5" }}>
          <span style={{ color: "#859900" }}>$</span> cast blame src/billing/webhooks.ts -L 41,43
        </div>
        {BLAME_LINES.map((l, i) => (
          <div key={i} {...fly(`blame/bl:${i}`, { position: "relative", whiteSpace: "pre" })}>
            {i === 0 && <span {...fly("blame/hlbar", { position: "absolute", left: -8, right: -8, top: 0, bottom: 0, transformOrigin: "0 50%", backgroundColor: "rgba(181,137,0,0.16)", borderRadius: 3 })} />}
            {l.session && (
              <span
                {...fly(`blame/who:${i}`, { position: "absolute", left: "8.5ch", width: "30.6ch", top: 2, bottom: 2, borderRadius: 3, backgroundColor: "rgba(38,139,210,0.28)", border: "1px solid rgba(38,139,210,0.55)" })}
              />
            )}
            <span className="relative">
              <span style={{ color: "#b58900" }}>{l.sha}</span> (<span style={{ color: l.session ? "#eee8d5" : "#93a1a1" }}>{l.who}</span> <span style={{ color: "#586e75" }}>{l.date}</span>) <span style={{ color: "#eee8d5" }}>{l.code}</span>
            </span>
          </div>
        ))}
        <div {...fly("blame/quote")} className="mt-3 ml-[8ch] max-w-[440px] rounded-lg px-3 py-2.5 text-[11.5px] leading-snug" style={{ backgroundColor: "#fdf6e3", color: INK, boxShadow: "0 12px 28px -14px rgba(0,0,0,0.7)" }}>
          <div className="mb-1.5 flex items-center gap-2 text-[10px]" style={{ color: DIM }}>
            <SessionPill title="Webhook API half" /> <AgentChip agent="codex" /> · 3w ago
          </div>
          &ldquo;Two attempts, then park it in the retry queue so Stripe never double charges.&rdquo;
        </div>
      </div>
    </div>
  );
}

/* ── Page: the published report ───────────────────────────────────────── */

function PageSurface() {
  return (
    <div className="relative h-full overflow-hidden font-mono text-left" style={{ backgroundColor: "#f5efdc" }}>
      <div {...fly("page/card", { position: "absolute", left: 150, right: 150, top: 90 })}>
        <div className="mb-2 text-[10px] uppercase tracking-wider" style={{ color: DIM }}>cast-canvas</div>
        <CanvasCard
          className="shadow-xl"
          bar={(rect, i) => <g {...fly(`page/bar:${i}`, { transformBox: "fill-box", transformOrigin: "50% 100%" })}>{rect}</g>}
        />
      </div>
      <div {...fly("page/chip", { position: "absolute", top: 22, left: 0, right: 0, display: "flex", justifyContent: "center" })}>
        <span className="relative rounded-md px-3 py-1.5 text-[12px]" style={{ backgroundColor: INK, color: "#eee8d5" }}>
          <span {...fly("page/chipCmd")}><span style={{ color: "#859900" }}>$</span> cast publish report.html</span>
          <span {...fly("page/chipUrl", { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#2aa198", whiteSpace: "nowrap" })}>codecast.sh/a/webhook-latency</span>
        </span>
      </div>
      <div {...fly("page/full", { position: "absolute", inset: 0, backgroundColor: "#fdf6e3" })} className="flex flex-col">
        <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: "#eee8d5", borderBottom: "1px solid #e4ddc8" }}>
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#dc322f" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#b58900" }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#859900" }} />
          <span className="mx-auto rounded-md px-3 py-1 text-[11px]" style={{ backgroundColor: "#fdf6e3", color: BODY, border: "1px solid #e4ddc8" }}>codecast.sh/a/webhook-latency</span>
          <span {...fly("page/viewers", { display: "inline-flex", alignItems: "center", gap: 6 })} className="rounded-full px-2 py-0.5 text-[10px]">
            <span className="flex -space-x-1.5"><Avatar initials="S" color="#6c71c4" /><Avatar initials="M" color="#d33682" /><Avatar initials="A" color="#cb4b16" /></span>
            <span style={{ color: BODY }}>3 viewers</span>
          </span>
        </div>
        <div className="flex flex-1 gap-6 px-8 py-6">
          <div className="min-w-0 flex-1">
            <div className="mb-2 text-[22px] font-bold leading-tight" style={{ color: INK }}>Webhook migration: latency report</div>
            <div className="mb-4 text-[12px] leading-relaxed" style={{ color: BODY }}>
              p95 down 71% across 16 endpoints.<br />Retries park after two attempts.
            </div>
            <CanvasCard />
          </div>
          <div className="w-[190px] shrink-0 space-y-2.5 pt-1">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: DIM }}>Comments</div>
            {[
              { i: "S", c: "#6c71c4", n: "sarah", t: "ship it" },
              { i: "M", c: "#d33682", n: "maya", t: "numbers look great" },
            ].map((c, k) => (
              <div key={c.i} {...fly(`page/comment:${k}`, { backgroundColor: "#ffffff", border: "1px solid #eee8d5" })} className="rounded-lg px-2.5 py-2 text-[11px]">
                <div className="mb-1 flex items-center gap-1.5 text-[10px]" style={{ color: DIM }}><Avatar initials={c.i} color={c.c} /> {c.n}</div>
                <div style={{ color: INK }}>{c.t}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── The world ────────────────────────────────────────────────────────── */

const RENDER: Record<SurfaceId, () => ReactNode> = {
  desk: DeskSurface,
  phone: PhoneSurface,
  pairA: PairASurface,
  pairB: PairBSurface,
  board: BoardSurface,
  palette: PaletteSurface,
  blame: BlameSurface,
  page: PageSurface,
};

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

function SurfaceMount({ s }: { s: Surface }) {
  const Render = RENDER[s.id];
  const phone = s.id === "phone";
  const face: CSSProperties = { position: "absolute", inset: 0, backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", borderRadius: s.radius, overflow: "hidden" };
  return (
    <div
      {...fly(`mount:${s.id}`, {
        position: "absolute",
        left: -s.w / 2,
        top: -s.h / 2,
        width: s.w,
        height: s.h,
        transformStyle: "preserve-3d",
        transform: `translate3d(${px(s.pos[0])}, ${px(s.pos[1])}, ${px(s.pos[2])}) rotateX(${s.rot[0]}deg) rotateY(${s.rot[1]}deg) rotateZ(${s.rot[2]}deg)`,
      })}
    >
      <div
        {...fly(`shadow:${s.id}`, {
          position: "absolute",
          left: "-6%",
          top: "2%",
          width: "112%",
          height: "112%",
          borderRadius: s.radius * 2,
          background: "radial-gradient(closest-side, rgba(0,43,54,0.16), rgba(0,43,54,0.07) 60%, rgba(0,43,54,0) 100%)",
        })}
      />
      <div {...fly(`card:${s.id}`, { position: "absolute", inset: 0, transformStyle: "preserve-3d" })}>
        <div style={{ ...face, ...(phone ? {} : { border: "1px solid #e4ddc8", boxShadow: "0 30px 60px -30px rgba(0,43,54,0.35)" }) }}>
          <Render />
        </div>
        <div
          style={{ ...face, transform: "rotateX(180deg)", backgroundColor: "#eee8d5", border: "1px solid #e4ddc8" }}
          className="flex flex-col items-center justify-center gap-3 font-mono"
        >
          <CodecastGlyph size={34} />
          <span className="text-[13px]" style={{ color: DIM }}>{s.back}</span>
        </div>
      </div>
    </div>
  );
}

function Ghost({ children }: { children: ReactNode }) {
  return (
    <div className="-translate-x-1/2 -translate-y-1/2 font-mono whitespace-nowrap">{children}</div>
  );
}

function GhostRow({ s }: { s: HeroSession }) {
  return (
    <Ghost>
      <div className="flex w-[300px] items-center gap-2 rounded-lg px-4 py-3" style={{ backgroundColor: "#fdf6e3", border: "1px solid #e4ddc8", boxShadow: "0 18px 40px -16px rgba(0,43,54,0.45)" }}>
        <StatusDot kind="working" />
        <span className="text-[13px] font-medium" style={{ color: INK }}>{s.title}</span>
        <span className="ml-auto"><AgentChip agent={s.agent} /></span>
      </div>
    </Ghost>
  );
}

const FLYER_RENDER: Record<string, () => ReactNode> = {
  ghostSpawnA: () => <GhostRow s={WORKER_A} />,
  ghostSpawnB: () => <GhostRow s={WORKER_B} />,
  ghostPermission: () => (
    <Ghost>
      <span className="flex items-center gap-2 rounded-full px-3.5 py-2 text-[12px] font-medium" style={{ backgroundColor: "#fdf6e3", color: "#b58900", border: "1px solid #b58900", boxShadow: "0 14px 30px -12px rgba(181,137,0,0.6)" }}>
        <StatusDot kind="needs-input" /> Permission needed
      </span>
    </Ghost>
  ),
  envelope: () => <Ghost><span className="inline-block origin-center scale-[1.5]" style={{ filter: "none" }}><SessionPill title="Webhook API half" /></span></Ghost>,
  envelopeBack: () => <Ghost><span className="inline-block origin-center scale-[1.4]"><SessionPill title="Dashboard retry UI" /></span></Ghost>,
  ghostTask: () => <Ghost><span className="inline-block origin-center scale-[1.4]"><TaskPill title="Retry queue for failed webhooks" /></span></Ghost>,
};

function Arc() {
  const [ax, ay] = ARC.from;
  const [bx, by] = ARC.to;
  const x0 = Math.min(ax, bx) - 20;
  const y0 = Math.min(ay, by) - 200;
  const w = Math.abs(ax - bx) + 40;
  const h = Math.abs(ay - by) + 240;
  const z = (ARC.from[2] + ARC.to[2]) / 2;
  const d = `M ${ax - x0} ${ay - y0} Q ${(ax + bx) / 2 - x0} ${Math.min(ay, by) - y0 - 170} ${bx - x0} ${by - y0}`;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", transform: `translate3d(${px(x0)}, ${px(y0)}, ${px(z)})` }}
    >
      <path {...fly(ARC.id, { strokeDasharray: 1, strokeDashoffset: F0.els[ARC.id]?.dash ?? 1 })} d={d} pathLength={1} fill="none" stroke="#859900" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/** Everything inside the camera: backdrop, surfaces, flyers. Rendered once; the driver writes styles to it. */
export const World = memo(function World() {
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: -5000,
          top: -3800,
          width: 10000,
          height: 7600,
          transform: "translateZ(-420px)",
          backgroundColor: "#fdf6e3",
          backgroundImage: "radial-gradient(#e4ddc8 1.4px, transparent 1.6px)",
          backgroundSize: "32px 32px",
        }}
      />
      {SURFACES.map((s) => <SurfaceMount key={s.id} s={s} />)}
      <Arc />
      {FLYERS.map((f) => (
        <div key={f.id} {...fly(f.id, { position: "absolute", left: 0, top: 0 })}>
          {FLYER_RENDER[f.id]()}
        </div>
      ))}
      <div
        {...fly("label3w", { position: "absolute", left: 0, top: 0, transform: `translate3d(${px(LABEL_3W.pos[0])}, ${px(LABEL_3W.pos[1])}, ${px(LABEL_3W.pos[2])})` })}
      >
        <span className="inline-block -translate-x-1/2 whitespace-nowrap font-mono text-[44px] font-bold" style={{ color: "rgba(0,43,54,0.8)" }}>3 weeks later</span>
      </div>
    </>
  );
});
