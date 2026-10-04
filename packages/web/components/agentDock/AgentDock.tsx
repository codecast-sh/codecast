"use client";

// The agent dock: a pill on the screen's edge with one dot per live agent,
// and beside it a card for whichever one needs you. It renders in its own
// see-through window (main.js "The agent dock", route /agent-dock).
//
// Everything it shows is the inbox, read from the same places the inbox reads:
//   the dots    the mine-scoped placement (useMinePlacement), one per row in
//               the questions, needs-input, working and done buckets
//   the card    the attention list: the decision queue first (polls,
//               permission prompts, `cast decide`), then rows waiting on you,
//               then finished ones. Answering goes through useDecisionAnswer,
//               the decision card's own model, and a reply through the real
//               session composer, so a message sent from the dock is the same
//               message sent from the conversation.
//
// Answer, discard and kill are HELD for two seconds before they commit: the
// card shows what is about to happen with a draining bar, and Esc takes it
// back. A dock answers in one keystroke, which makes a wrong keystroke cheap
// to make; the hold makes it cheap to undo, without the agent ever seeing the
// answer it was not meant to get.
import { useCallback, useMemo, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Inbox, Plus, Settings2, X } from "lucide-react";
import { getProjectName, useInboxStore, type InboxSession } from "../../store/inboxStore";
import { useMinePlacement } from "../../hooks/useNeedsInputCount";
import { useDecisionQueue, lastAssistantText } from "../../hooks/useDecisionQueue";
import { useDecisionAnswer } from "../../hooks/useDecisionAnswer";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { formatTimeAgo } from "../../lib/messageNavigator";
import type { QueueItem } from "../../lib/decisionQueue";
import {
  agentDockCapture,
  agentDockCompose,
  agentDockContentSize,
  agentDockFocus,
  agentDockInteractive,
  agentDockOpen,
  getAgentDock,
  onAgentDockSummon,
  type AgentDockEdge,
} from "../../lib/desktopAgentDock";
import { MessageInput } from "../MessageInput";
import { PermissionStack } from "../PermissionCard";
import { SessionPrewarm } from "../SessionPrewarm";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { HOLD_MS, nextEntryId, type DockDot, type DockEntry } from "./dockModel";
import "./agentDock.css";

export function AgentDock() {
  const placed = useMinePlacement();
  const queue = useDecisionQueue();
  const [edge, setEdge] = useState<AgentDockEdge>("right");
  useMountEffect(() => { void getAgentDock().then((c) => c && setEdge(c.edge)); });

  // The attention list, in the order the card walks it.
  const entries = useMemo<DockEntry[]>(() => {
    if (!placed) return [];
    const seen = new Set<string>();
    const out: DockEntry[] = [];
    const push = (e: DockEntry) => { if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } };
    for (const item of queue) if (!item.heldByRole && item.session) push({ id: item.conversationId, kind: "ask", session: item.session, item });
    for (const s of [...placed.questions, ...placed.needsInput]) push({ id: s._id, kind: "waiting", session: s });
    for (const s of placed.done) push({ id: s._id, kind: "done", session: s });
    return out;
  }, [placed, queue]);

  // One dot per live agent: what needs you on top, then what is running,
  // then what finished. Capped so the pill never runs down the screen.
  const dots = useMemo<DockDot[]>(() => {
    if (!placed) return [];
    const rows: Array<[InboxSession, DockDot["state"]]> = [
      ...[...placed.questions, ...placed.needsInput].map((s) => [s, "needs"] as [InboxSession, DockDot["state"]]),
      ...placed.working.map((s) => [s, "working"] as [InboxSession, DockDot["state"]]),
      ...placed.done.map((s) => [s, "done"] as [InboxSession, DockDot["state"]]),
    ];
    const seen = new Set<string>();
    return rows
      .filter(([s]) => (seen.has(s._id) ? false : (seen.add(s._id), true)))
      .slice(0, 12)
      .map(([s, state]) => ({ id: s._id, state, title: s.title || "Untitled" }));
  }, [placed]);

  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId !== null;
  // A dot for a working agent opens it too, though it is in no attention
  // bucket: the card then shows that one session ahead of the list.
  const sessions = useInboxStore((s) => s.sessions);
  const current: DockEntry | null = useMemo(() => {
    if (!openId) return null;
    const hit = entries.find((e) => e.id === openId);
    if (hit) return hit;
    const s = sessions[openId];
    return s ? { id: openId, kind: "working", session: s } : null;
  }, [openId, entries, sessions]);

  const openCard = useCallback((id?: string) => {
    const target = id ?? entries[0]?.id ?? null;
    setOpenId(target ?? "__empty");
  }, [entries]);
  const close = useCallback(() => setOpenId(null), []);

  // The card takes the keyboard while it is open and gives it back on close.
  useWatchEffect(() => { agentDockFocus(open); }, [open]);
  useWatchEffect(() => onAgentDockSummon(() => openCard()), [openCard]);

  // The window is exactly as big as what it draws.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) agentDockContentSize({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const needs = entries.filter((e) => e.kind !== "done").length;
  const hover = { onPointerEnter: () => agentDockInteractive(true), onPointerLeave: () => agentDockInteractive(false) };

  return (
    <div
      ref={rootRef}
      className={`dark inline-flex items-start gap-2 p-2 text-sol-text ${edge === "left" ? "flex-row-reverse" : "flex-row"}`}
    >
      {open && (
        <div {...hover}>
          {current ? (
            <DockCard
              key={current.id}
              entry={current}
              entries={entries}
              onGo={(id) => setOpenId(id)}
              onClose={close}
            />
          ) : (
            <AllClear onClose={close} />
          )}
        </div>
      )}
      <div {...hover} className="flex flex-col items-center gap-1.5 select-none">
        <PillButton label={needs ? `${needs} waiting on you` : "Inbox"} onClick={() => (open ? close() : openCard())} badge={needs > 0}>
          <Inbox className="h-[15px] w-[15px]" />
        </PillButton>
        {dots.length > 0 && (
          <div className="dock-glass flex flex-col items-center gap-[7px] rounded-full px-[7px] py-2.5">
            {dots.map((d) => (
              <button
                key={d.id}
                title={d.title}
                onClick={() => openCard(d.id)}
                className={`flex h-3 w-3 items-center justify-center rounded-full transition-transform hover:scale-125 ${openId === d.id ? "ring-1 ring-white/60 ring-offset-1 ring-offset-transparent" : ""}`}
              >
                <DotGlyph state={d.state} />
              </button>
            ))}
          </div>
        )}
        <div className="dock-glass flex flex-col items-center gap-1 rounded-full p-1">
          <PillButton bare label="New agent" onClick={agentDockCompose}><Plus className="h-[15px] w-[15px]" /></PillButton>
          <PillButton
            bare
            label="Screenshot a region, then reply with it"
            onClick={async () => {
              const shot = await agentDockCapture();
              if (shot) pendingShot.current = shot;
              if (shot) openCard(openId && openId !== "__empty" ? openId : undefined);
            }}
          >
            <Camera className="h-[15px] w-[15px]" />
          </PillButton>
          <PillButton bare label="Dock settings" onClick={() => agentDockOpen("/settings/desktop")}><Settings2 className="h-[15px] w-[15px]" /></PillButton>
        </div>
      </div>
    </div>
  );
}

// A framed screenshot waiting for the next composer that mounts. Module state
// on purpose: the card that takes it may not exist yet when the picker returns.
const pendingShot: { current: string | null } = { current: null };

function DotGlyph({ state }: { state: DockDot["state"] }) {
  if (state === "working") {
    return <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-sol-blue border-t-transparent" />;
  }
  return <span className={`h-2 w-2 rounded-full ${state === "needs" ? "bg-sol-orange shadow-[0_0_6px] shadow-sol-orange/70" : "bg-sol-green"}`} />;
}

function PillButton({ children, label, onClick, badge, bare }: { children: React.ReactNode; label: string; onClick: () => void; badge?: boolean; bare?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`relative flex h-8 w-8 items-center justify-center rounded-full text-sol-text-muted transition-colors hover:text-sol-text ${bare ? "hover:bg-white/10" : "dock-glass"}`}
    >
      {children}
      {badge && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-sol-orange" />}
    </button>
  );
}

function AllClear({ onClose }: { onClose: () => void }) {
  useCardKeys({ onClose });
  return (
    <div className="dock-glass dock-card flex w-[300px] items-center justify-between rounded-2xl px-4 py-3 text-sm">
      <span className="text-sol-text-muted">Nothing is waiting on you.</span>
      <button onClick={onClose} className="text-sol-text-dim hover:text-sol-text"><X className="h-4 w-4" /></button>
    </div>
  );
}

type Held = { label: string; tone: "ok" | "kill" | "quiet"; commit: () => void; picked?: number };

function DockCard({ entry, entries, onGo, onClose }: { entry: DockEntry; entries: DockEntry[]; onGo: (id: string | null) => void; onClose: () => void }) {
  const { session } = entry;
  const item: QueueItem | null = entry.kind === "ask" ? entry.item ?? null : null;
  const decision = useDecisionAnswer(item);
  const stashSession = useInboxStore((s) => s.stashSession);
  const killSession = useInboxStore((s) => s.killSession);
  const messages = useInboxStore((s) => s.messages[entry.id]);
  const now = useCoarseNow(30_000);

  const position = entries.findIndex((e) => e.id === entry.id);
  const prevId = position > 0 ? entries[position - 1].id : null;
  const nextId = position >= 0 ? entries[position + 1]?.id ?? null : entries[0]?.id ?? null;

  // The hold: what is about to happen, committed when the bar drains, taken
  // back by Esc. The card moves on to the next entry the moment it commits.
  const [held, setHeld] = useState<Held | null>(null);
  const after = useMemo(() => nextEntryId(entries, entry.id), [entries, entry.id]);
  useWatchEffect(() => {
    if (!held) return;
    const t = setTimeout(() => {
      held.commit();
      onGo(after);
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [held, after, onGo]);
  const hold = useCallback((h: Held) => setHeld((cur) => cur ?? h), []);

  const options = useMemo(
    () => (item && !decision.isInfraDialog && !decision.isPermissionCard ? decision.options : []),
    [item, decision.isInfraDialog, decision.isPermissionCard, decision.options],
  );
  const answerAt = useCallback((n: number) => {
    const opt = options[n];
    if (!opt) return;
    hold({ label: `Answered "${opt.label}"`, tone: "ok", commit: () => decision.answer(opt.index), picked: n });
  }, [options, hold, decision]);
  const discard = useCallback(() => hold({
    label: "Discarded",
    tone: "quiet",
    commit: () => (item ? decision.dismiss() : stashSession(entry.id)),
  }), [hold, item, decision, stashSession, entry.id]);
  const kill = useCallback(() => hold({ label: "Agent killed", tone: "kill", commit: () => killSession(entry.id) }), [hold, killSession, entry.id]);

  useCardKeys({
    onClose: () => (held ? setHeld(null) : onClose()),
    onPrev: prevId ? () => onGo(prevId) : undefined,
    onNext: nextId ? () => onGo(nextId) : undefined,
    onDigit: held ? undefined : answerAt,
    onDiscard: held ? undefined : discard,
    onKill: held || item ? undefined : kill,
  });

  const project = session.project_path ? getProjectName(session.project_path) : undefined;
  const status = statusLine(entry, decision.isPermissionCard, now);
  const lastUser = useMemo(() => lastUserText(messages as any[]), [messages]);
  const said = entry.kind === "ask" ? decision.recentText : lastAssistantText(messages as any[]) ?? session.idle_summary;

  return (
    <div className="dock-glass dock-card flex w-[380px] flex-col overflow-hidden rounded-[22px]">
      <SessionPrewarm sessionId={entry.id} />
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{session.title || "Untitled"}</div>
          <div className="truncate text-xs text-sol-text-dim">
            {status}{project ? ` · ${project}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          <span className="mr-1 text-[11px] tabular-nums text-sol-text-dim">
            {position >= 0 ? `${position + 1} of ${entries.length}` : ""}
          </span>
          <NavButton disabled={!prevId} onClick={() => prevId && onGo(prevId)} label="Previous" keyName="J"><ChevronLeft className="h-3.5 w-3.5" /></NavButton>
          <NavButton disabled={!nextId} onClick={() => nextId && onGo(nextId)} label="Next" keyName="K"><ChevronRight className="h-3.5 w-3.5" /></NavButton>
          <NavButton onClick={onClose} label="Close" keyName="esc"><X className="h-3.5 w-3.5" /></NavButton>
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto px-4 pb-1 pt-2.5">
        {lastUser && (
          <div className="mb-2 flex justify-end">
            <div className="line-clamp-2 max-w-[85%] rounded-2xl rounded-br-md bg-sol-blue/80 px-3 py-1.5 text-[13px] text-white">{lastUser}</div>
          </div>
        )}

        {entry.kind === "ask" && decision.isPermissionCard && <PermissionStack permissions={decision.permissions} />}

        {entry.kind === "ask" && !decision.isPermissionCard && (
          <>
            {decision.question && <div className="mb-2 text-[14px] font-semibold leading-snug">{decision.question}</div>}
            {decision.isInfraDialog && (
              <div className="mb-2 text-xs text-sol-text-dim">A usage prompt. Open the agent to handle it.</div>
            )}
            <div className="flex flex-col gap-1">
              {options.map((o, n) => (
                <button
                  key={o.index}
                  disabled={!!held}
                  onClick={() => answerAt(n)}
                  className={`group flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors ${held?.picked === n ? "bg-sol-green/25 text-sol-text" : "bg-white/[0.04] hover:bg-white/[0.09] disabled:opacity-40"}`}
                >
                  <KeyCap size="xs">{n + 1}</KeyCap>
                  <span className="min-w-0">
                    <span className="block">{o.label}</span>
                    {o.description && <span className="block text-xs text-sol-text-dim">{o.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {entry.kind !== "ask" && said && (
          <div className="dock-said rounded-xl bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed">
            <MarkdownRenderer content={said} />
          </div>
        )}
      </div>

      {held ? (
        <HeldBar held={held} onUndo={() => setHeld(null)} />
      ) : (
        <div className="px-3 pb-3 pt-1.5">
          {entry.kind === "ask" ? (
            !decision.isPermissionCard && <FreeTextAnswer onSend={(text) => hold({ label: "Answer sent", tone: "ok", commit: () => decision.answerFreeText(text) })} />
          ) : (
            <DockComposer conversationId={entry.id} />
          )}
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button onClick={() => agentDockOpen(`/conversation/${entry.id}`)} className="mr-auto rounded-full px-2.5 py-1 text-xs text-sol-text-dim hover:bg-white/10 hover:text-sol-text">
              Open agent
            </button>
            {!item && (
              <button onClick={kill} className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-sol-red hover:bg-sol-red/15">
                Kill agent <KeyCap size="xs">X</KeyCap>
              </button>
            )}
            <button onClick={discard} className="flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-black hover:bg-white">
              {item ? "Dismiss" : "Discard"} <KeyCap size="xs" tone="onAccent">E</KeyCap>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HeldBar({ held, onUndo }: { held: Held; onUndo: () => void }) {
  const [drain, setDrain] = useState(false);
  useMountEffect(() => { const r = requestAnimationFrame(() => setDrain(true)); return () => cancelAnimationFrame(r); });
  const dot = held.tone === "kill" ? "bg-sol-red" : held.tone === "ok" ? "bg-sol-green" : "bg-sol-blue";
  return (
    <div className="relative mx-3 mb-3 mt-1.5 overflow-hidden rounded-xl bg-white/[0.06] px-3 py-2.5">
      <div className="flex items-center gap-2.5 text-[13px]">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="flex-1 truncate">{held.label}</span>
        <button onClick={onUndo} className="flex items-center gap-1.5 text-xs text-sol-text-muted hover:text-sol-text">
          <KeyCap size="xs">esc</KeyCap> to undo
        </button>
      </div>
      <div
        className="absolute bottom-0 left-0 h-[2px] bg-sol-blue ease-linear"
        style={{ width: drain ? "0%" : "100%", transitionProperty: "width", transitionDuration: `${HOLD_MS}ms` }}
      />
    </div>
  );
}

function FreeTextAnswer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <textarea
      rows={1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (text.trim()) onSend(text);
        }
      }}
      placeholder="Type your answer…"
      className="w-full resize-none rounded-xl bg-white/[0.06] px-3 py-2 text-[13px] outline-none placeholder:text-sol-text-dim focus:bg-white/[0.09]"
    />
  );
}

// The real session composer, laid out inline. A framed screenshot waiting
// from the pill's camera lands in it as a pasted image.
function DockComposer({ conversationId }: { conversationId: string }) {
  const dropFiles = useRef<((files: File[]) => void) | null>(null);
  useWatchEffect(() => {
    const shot = pendingShot.current;
    if (!shot || !dropFiles.current) return;
    pendingShot.current = null;
    void fetch(shot).then((r) => r.blob()).then((blob) => {
      dropFiles.current?.([new File([blob], "screenshot.png", { type: "image/png" })]);
    });
  }, [conversationId]);
  return (
    <div className="dock-composer">
      <MessageInput conversationId={conversationId} inline embedded autoFocusInput onDropFiles={dropFiles} composerPlaceholder="Reply…" />
    </div>
  );
}

function NavButton({ children, onClick, label, keyName, disabled }: { children: React.ReactNode; onClick: () => void; label: string; keyName: string; disabled?: boolean }) {
  return (
    <button
      title={`${label} (${keyName})`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.06] text-sol-text-muted hover:bg-white/15 hover:text-sol-text disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// The card's keys. Esc always reaches it; the letters and digits stand down
// while a text field has the caret, so typing a reply never answers a poll.
function useCardKeys(h: { onClose: () => void; onPrev?: () => void; onNext?: () => void; onDigit?: (n: number) => void; onDiscard?: () => void; onKill?: () => void }) {
  const ref = useRef(h);
  ref.current = h;
  const onKey = useCallback((e: KeyboardEvent) => {
    const k = ref.current;
    if (e.key === "Escape") { e.preventDefault(); k.onClose(); return; }
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "j") k.onPrev?.();
    else if (key === "k") k.onNext?.();
    else if (key === "e") k.onDiscard?.();
    else if (key === "x") k.onKill?.();
    else if (/^[1-9]$/.test(key)) k.onDigit?.(Number(key) - 1);
    else return;
    e.preventDefault();
  }, []);
  useEventListener("keydown", onKey, typeof window === "undefined" ? null : window, { capture: true });
}

function statusLine(entry: DockEntry, permission: boolean, now: number): string {
  if (entry.kind === "ask") return permission ? "Needs your approval" : "Waiting for your answer";
  if (entry.kind === "waiting") return "Waiting on you";
  if (entry.kind === "working") return "Working";
  const at = entry.session.updated_at;
  const ago = at ? formatTimeAgo(at, now) : null;
  return !ago || ago === "now" ? "Finished just now" : /^\d+[mhd]$/.test(ago) ? `Finished ${ago} ago` : `Finished ${ago}`;
}

function lastUserText(raw: any[] | undefined): string | undefined {
  if (!raw?.length) return undefined;
  const sorted = [...raw].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m.role !== "user") continue;
    const text = (m.content ?? "").trim();
    if (text && !text.startsWith("<")) return text;
  }
  return undefined;
}
