"use client";
// The session map (/map): every live session on one canvas you can zoom
// around, sitting in piles. The org is drawn on top (people, and each role
// under whoever it reports to, its sessions in its pile); every other session
// sits in its repository's pile on the shelves below. Drag a card onto a pile
// you made to file it there, onto bare canvas to leave it loose, onto another
// loose card to start a pile, or onto another role or person to have it
// report there (asked first). Lasso cards to pile them; fold a pile into a
// stack. The arrangement is clientState.ui.session_map (sessionMapModel).
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useOnSelectionChange,
  useOnViewportChange,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Folder, Layers, LayoutGrid, MousePointer2, Rows3, Search, SquareStack, Undo2, X } from "lucide-react";
import type { WorkState } from "@codecast/shared/contracts";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore, sessionWorkState, type InboxSession } from "../../store/inboxStore";
import { makeCollectionSig } from "../../store/wakeSig";
import { reparentToastLine } from "../../store/orgSlice";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { animatedHideSessions } from "../../store/undoActions";
import { AgentMenu, SelectionBar, ToolButton, ViewMenu, type SelectionActions } from "./MapControls";
import { useTheme } from "../ThemeProvider";
import { Avatar } from "../tasks/TaskCommentStream";
import { RoleFace } from "../org/RoleFace";
import { ORG_STATE_META } from "../org/orgMeta";
import { CardNode, useMapLevel, type CardData } from "./MapCard";
import { MoveConfirm } from "../org/useOrgMoves";
import type { OrgReparentRequest } from "../org/OrgGraph";
import type { OrgTree } from "../org/orgTypes";
import { cn } from "../../lib/utils";
import {
  buildPiles,
  CARD,
  cardNodeId,
  cardSlot,
  createPile,
  customPileId,
  defaultOrder,
  defaultPositions,
  freeSpot,
  newPileSize,
  GROUPS,
  ORDERS,
  setFolded,
  SINCES,
  SORTS,
  dissolvePile,
  HAIRLINE,
  makeLoose,
  moveToPile,
  personNodeId,
  pileCards,
  pileSize,
  PERSON,
  placeNodes,
  renamePile,
  repoOf,
  rolePileId,
  SETTLED_TILE,
  STATE_ORDER,
  tidy,
  toggleIn,
  type MapPerson,
  type MapRole,
  type MapSession,
  type Pile,
  type SessionMapLayout,
  type SessionMapView,
} from "./sessionMapModel";

const EMPTY_LAYOUT: SessionMapLayout = {};
// One object for the life of the page: React Flow copies fitViewOptions into its
// store whenever the object changes, so a fresh one per render would replace the
// options of a fit already queued (a double-click on a card) with "fit everything".
const FIT_ALL = { padding: 0.1 };
const VIEWPORT_KEY = "session-map:viewport";
const EMPTY_VIEW: SessionMapView = {};
const NO_ROLES: MapRole[] = [];
const NO_PEOPLE: MapPerson[] = [];
const PASS_THROUGH = { pointerEvents: "none" } as const;
const PAN_BUTTONS = [1, 2];
/** The height of a pile's zoomed-out name above it, in canvas units (its 14px label at the far zoom stop). */
const TITLE_BAND = 200;
const MULTI_KEYS = ["Meta", "Control", "Shift"];

// ---------------------------------------------------------------- data

/** The fields the map draws from a session row; heartbeats change none of them. */
const sessionsSig = makeCollectionSig((s: InboxSession) => [
  s._id, s.title, s.short_title, sessionWorkState(s), s.org_role_id, s.standing_role_id, s.git_remote_url, s.git_root, s.project_path,
  s.inbox_killed_at ? 1 : 0, s.is_subagent ? 1 : 0, s.parent_conversation_id, s.thread_state, s.agent_type, s.role?.name,
  s.model, s.git_branch, s.worktree_branch, s.active_task?.short_id, Math.round((s.message_count ?? 0) / 10),
].join("\u0001"));

function collect(rows: Record<string, InboxSession>, tree: OrgTree | null): { sessions: MapSession[]; roles: MapRole[]; people: MapPerson[] } {
  const workers = new Map<string, number>();
  const snapRoles = new Map<string, MapRole>();
  const top: InboxSession[] = [];
  for (const s of Object.values(rows)) {
    if (s.inbox_killed_at) continue;
    if (s.is_subagent || s.parent_conversation_id) {
      if (s.parent_conversation_id) workers.set(s.parent_conversation_id, (workers.get(s.parent_conversation_id) ?? 0) + 1);
      continue;
    }
    top.push(s);
    // A role's standing agent sits in that role's own pile, not its manager's.
    const roleId = s.standing_role_id ?? s.org_role_id;
    if (roleId && s.role && !snapRoles.has(roleId)) snapRoles.set(roleId, { id: roleId, name: s.role.name, handle: s.role.handle, avatar: s.role.avatar, shortId: s.role.short_id });
  }
  const people: MapPerson[] = [];
  const personIds = new Set<string>();
  const roles: MapRole[] = [];
  const roleIds = new Set<string>();
  for (const r of tree?.roles ?? []) {
    if (r.status === "retired") continue;
    roleIds.add(r._id);
  }
  for (const r of tree?.roles ?? []) {
    if (r.status === "retired") continue;
    let parent: string | undefined;
    if (r.reports_to.kind === "role" && roleIds.has(r.reports_to.role_id)) parent = rolePileId(r.reports_to.role_id);
    if (r.reports_to.kind === "user") { parent = personNodeId(r.reports_to.user_id); personIds.add(r.reports_to.user_id); }
    roles.push({ id: r._id, name: r.name, handle: r.handle, avatar: r.avatar, shortId: r.short_id, line: r.standing?.state_line ?? null, parent });
  }
  for (const [id, r] of snapRoles) if (!roleIds.has(id)) roles.push(r);
  for (const p of tree?.people ?? []) if (personIds.has(p.user_id)) people.push({ id: p.user_id, name: p.name, image: p.image, presence: p.presence });
  // A role whose person is not on the tree reports to nobody drawn.
  for (const r of roles) if (r.parent?.startsWith("person:") && !people.some((p) => personNodeId(p.id) === r.parent)) r.parent = undefined;
  const sessions = top.map((s): MapSession => ({
    id: s._id,
    title: s.short_title || s.title || "Untitled",
    state: sessionWorkState(s),
    updated_at: s.updated_at ?? 0,
    agent_type: s.agent_type,
    line: s.thread_state || s.idle_summary || null,
    roleId: s.standing_role_id ?? s.org_role_id ?? null,
    repo: repoOf(s),
    workers: workers.get(s._id) ?? 0,
    model: s.model ?? null,
    messages: s.message_count ?? 0,
    branch: s.worktree_branch || s.git_branch || null,
    task: s.active_task ? { shortId: s.active_task.short_id, title: s.active_task.title } : null,
  }));
  return { sessions, roles, people };
}

// ---------------------------------------------------------------- nodes

type PileData = { pile: Pile; dim: boolean; renaming: boolean; edit: PileEdit };
type TileData = { pile: Pile; dim: boolean; edit: PileEdit };
type PersonData = { person: MapPerson };
type PileEdit = {
  fold: (id: string) => void;
  openSettled: (id: string) => void;
  rename: (id: string, title: string | null) => void;
  startRename: (id: string) => void;
  dissolve: (id: string) => void;
  openRole: (role: MapRole) => void;
};

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, pointerEvents: "none" } as const;

function StateDot({ state, size = 7 }: { state: WorkState; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: ORG_STATE_META[state].color }} />;
}

function counts(list: MapSession[]): [WorkState, number][] {
  const c = new Map<WorkState, number>();
  for (const s of list) c.set(s.state, (c.get(s.state) ?? 0) + 1);
  return STATE_ORDER.filter((s) => c.get(s)).map((s) => [s, c.get(s)!]);
}

function Counts({ list }: { list: MapSession[] }) {
  return (
    <span className="flex items-center gap-[0.6em] tabular-nums" style={{ color: "var(--sol-text-muted)" }}>
      {counts(list).map(([state, n]) => <span key={state} className="flex items-center gap-1" title={ORG_STATE_META[state].label}><StateDot state={state} size={6} />{n}</span>)}
    </span>
  );
}

function PileTitle({ pile, renaming, edit }: { pile: Pile; renaming: boolean; edit: PileEdit }) {
  if (renaming) {
    return (
      <input
        autoFocus
        defaultValue={pile.title}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => edit.rename(pile.id, e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") edit.rename(pile.id, null);
          e.stopPropagation();
        }}
        className="nodrag min-w-0 flex-1 rounded border bg-transparent px-1 text-[13px] font-semibold outline-none"
        style={{ borderColor: "var(--sol-blue)", color: "var(--sol-text)" }}
      />
    );
  }
  return (
    <span
      className="min-w-0 shrink truncate text-[13px] font-semibold"
      style={{ color: "var(--sol-text)" }}
      onDoubleClick={pile.kind === "custom" ? () => edit.startRename(pile.id) : undefined}
      title={pile.kind === "custom" ? `${pile.title} (double-click to rename)` : pile.title}
    >
      {pile.title}
    </span>
  );
}

function PileIcon({ pile, edit }: { pile: Pile; edit: PileEdit }) {
  if (pile.role) {
    const role = pile.role;
    return (
      <button type="button" className="nodrag shrink-0 rounded-full" onClick={(e) => { e.stopPropagation(); edit.openRole(role); }} title={`@${role.handle}`}>
        <RoleFace role={role} size={22} />
      </button>
    );
  }
  const Icon = pile.kind === "custom" ? Layers : Folder;
  return <Icon className="h-4 w-4 shrink-0" style={{ color: pile.kind === "custom" ? "var(--sol-blue)" : "var(--sol-text-dim)" }} />;
}

const PileNode = memo(function PileNode({ data }: NodeProps<Node<PileData>>) {
  const { pile, dim, renaming, edit } = data;
  const level = useMapLevel();
  const { w, h } = pileSize(pile);
  const all = [...pile.active, ...pile.settled];
  const accent = pile.kind === "role" ? "var(--sol-violet)" : pile.kind === "custom" ? "var(--sol-blue)" : "var(--sol-border)";
  return (
    <div className="relative" style={{ width: w, height: h, opacity: dim ? 0.35 : 1 }} data-map-pile={pile.id}>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      {/* Zoomed out, the name rides above the pile at a size that stays readable from far away. */}
      {level === "far" && (
        <div className="map-pile-head pointer-events-auto absolute bottom-full left-0 mb-2 w-full truncate whitespace-nowrap font-semibold leading-none" style={{ fontSize: `min(calc(14px / min(1, var(--mapz, 1))), ${Math.round(w / (Math.max(pile.title.length, 4) * 0.62))}px)`, color: pile.kind === "role" ? "var(--sol-violet)" : "var(--sol-text)", cursor: "grab" }}>
          {pile.title}
        </div>
      )}
      {pile.folded && (
        <>
          <div aria-hidden className="absolute inset-0 translate-x-[8px] translate-y-[8px] rounded-xl border" style={{ background: "var(--sol-bg-alt)", borderColor: HAIRLINE }} />
          <div aria-hidden className="absolute inset-0 translate-x-[4px] translate-y-[4px] rounded-xl border" style={{ background: "var(--sol-bg-alt)", borderColor: HAIRLINE }} />
        </>
      )}
      <div className="absolute inset-0 rounded-xl border" style={{ background: "var(--sol-bg-alt)", borderColor: HAIRLINE, borderTop: `3px solid ${accent}` }}>
        <div className="map-pile-head pointer-events-auto flex h-[44px] items-center gap-2 px-3" style={{ cursor: "grab" }}>
          <button type="button" className="nodrag -ml-1 rounded p-0.5 hover:bg-sol-bg-highlight" onClick={() => edit.fold(pile.id)} aria-label={pile.folded ? "Spread pile" : "Fold pile"} aria-expanded={!pile.folded}>
            {pile.folded ? <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--sol-text-dim)" }} /> : <ChevronDown className="h-3.5 w-3.5" style={{ color: "var(--sol-text-dim)" }} />}
          </button>
          <PileIcon pile={pile} edit={edit} />
          <PileTitle pile={pile} renaming={renaming} edit={edit} />
          {pile.role?.line && !pile.folded && <span className="min-w-0 flex-[2] truncate text-[12px]" style={{ color: "var(--sol-text-dim)" }} title={pile.role.line}>{pile.role.line}</span>}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{all.length}</span>
          {pile.kind === "custom" && (
            <button type="button" className="nodrag rounded p-0.5 hover:bg-sol-bg-highlight" onClick={() => edit.dissolve(pile.id)} aria-label="Unpile" title="Unpile: cards go back to their role or repo">
              <X className="h-3.5 w-3.5" style={{ color: "var(--sol-text-dim)" }} />
            </button>
          )}
        </div>
        {pile.folded && (
          // A stack is one press away from spread: the whole deck opens it.
          <button type="button" onClick={() => edit.fold(pile.id)} className="nodrag pointer-events-auto flex w-full flex-col gap-[0.4em] px-3 text-left" style={{ fontSize: "clamp(11.5px, calc(11.5px / var(--mapz, 1)), 26px)" }} aria-label={`Spread ${pile.title}`} data-map-deck={pile.id}>
            <Counts list={all} />
            {[...pile.active, ...pile.settled].slice(0, 3).map((s) => (
              <span key={s.id} className="flex w-full items-center gap-[0.4em]" style={{ color: "var(--sol-text-muted)" }}><StateDot state={s.state} size={6} /><span className="truncate">{s.title}</span></span>
            ))}
          </button>
        )}
      </div>
    </div>
  );
});

const TileNode = memo(function TileNode({ data }: NodeProps<Node<TileData>>) {
  const { pile, dim, edit } = data;
  return (
    <button
      type="button"
      onClick={() => edit.openSettled(pile.id)}
      className="nodrag flex items-center justify-center gap-3 rounded-lg border border-dashed px-3 text-left hover:bg-sol-bg-highlight/60"
      style={{ width: CARD.w, height: CARD.h, borderColor: HAIRLINE, color: "var(--sol-text-muted)", opacity: dim ? 0.18 : 1 }}
      data-map-settled={pile.id}
    >
      <span className="font-semibold tabular-nums" style={{ fontSize: "clamp(18px, calc(16px / var(--mapz, 1)), 96px)", color: "var(--sol-text)" }}>{pile.settled.length}</span>
      <span className="flex flex-col gap-0.5" style={{ fontSize: "clamp(11px, calc(11px / var(--mapz, 1)), 40px)" }}>
        <span>settled</span>
        <Counts list={pile.settled} />
      </span>
    </button>
  );
});

const PersonNode = memo(function PersonNode({ data }: NodeProps<Node<PersonData>>) {
  const { person } = data;
  return (
    <div className="flex items-center gap-2.5 rounded-full border px-3" style={{ width: PERSON.w, height: PERSON.h, background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-cyan) 45%, transparent)", cursor: "grab" }} data-map-person={person.id}>
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      <Avatar name={person.name} image={person.image} size="md" />
      <span className="min-w-0 flex-1 truncate font-semibold" style={{ fontSize: "clamp(16px, calc(13px / var(--mapz, 1)), 40px)", color: "var(--sol-text)" }}>{person.name}</span>
    </div>
  );
});

const NODE_TYPES = { card: CardNode, pile: PileNode, tile: TileNode, person: PersonNode };

// ---------------------------------------------------------------- canvas

function readViewport(): Viewport | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWPORT_KEY) ?? "null");
    return v && typeof v.zoom === "number" ? v : undefined;
  } catch { return undefined; }
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function SessionMapInner() {
  useSyncOrgTreeFeeder();
  const router = useRouter();
  const { theme } = useTheme();
  const flow = useReactFlow();
  const now = useCoarseNow(60_000);
  const sig = useInboxStore((s) => sessionsSig(s.sessions));
  const tree = useInboxStore((s) => s.orgTree);
  const layout = useInboxStore((s) => s.clientState.ui?.session_map) ?? EMPTY_LAYOUT;
  const view = useInboxStore((s) => s.clientState.ui?.session_map_view) ?? EMPTY_VIEW;
  const { sessions, roles, people } = useMemo(() => collect(useInboxStore.getState().sessions, tree), [sig, tree, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const group = view.group ?? "org";
  const order = view.order ?? defaultOrder(group);
  const since = view.since ?? "all";
  const hiddenStates = useMemo(() => new Set(view.hiddenStates ?? []), [view.hiddenStates]);
  const hiddenAgents = useMemo(() => new Set(view.hiddenAgents ?? []), [view.hiddenAgents]);
  const setView = useCallback((patch: Partial<SessionMapView>) => {
    const cur = useInboxStore.getState().clientState.ui?.session_map_view ?? EMPTY_VIEW;
    useInboxStore.getState().updateClientUI({ session_map_view: { ...cur, ...patch } });
  }, []);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<SessionMapLayout[]>([]);
  const [pending, setPending] = useState<{ req: OrgReparentRequest; ids: string[]; pileId: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const save = useCallback((next: SessionMapLayout) => {
    const prev = useInboxStore.getState().clientState.ui?.session_map ?? EMPTY_LAYOUT;
    if (next === prev) return;
    setHistory((h) => [...h.slice(-29), prev]);
    useInboxStore.getState().updateClientUI({ session_map: next });
  }, []);
  const current = () => useInboxStore.getState().clientState.ui?.session_map ?? EMPTY_LAYOUT;
  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      useInboxStore.getState().updateClientUI({ session_map: h[h.length - 1] });
      return h.slice(0, -1);
    });
  }, []);

  const edit = useMemo<PileEdit>(() => ({
    fold: (id) => save(toggleIn(current(), "folded", id)),
    openSettled: (id) => save(toggleIn(current(), "settledOpen", id)),
    rename: (id, title) => { setRenaming(null); if (title !== null) save(renamePile(current(), id, title)); },
    startRename: setRenaming,
    dissolve: (id) => save(dissolvePile(current(), id)),
    openRole: (role) => router.push(objectHref("role", role.shortId ?? role.id)),
  }), [save, router]);

  // Filters: how recent, which agents, which states. Each control counts what the others leave.
  const sinceMs = SINCES.find((x) => x.id === since)!.ms;
  const recent = useMemo(() => sessions.filter((s) => now - s.updated_at < sinceMs), [sessions, now, sinceMs]);
  const visible = useMemo(() => recent.filter((s) => !hiddenStates.has(s.state) && !hiddenAgents.has(s.agent_type)), [recent, hiddenStates, hiddenAgents]);
  const stateCounts = useMemo(() => counts(recent.filter((s) => !hiddenAgents.has(s.agent_type))), [recent, hiddenAgents]);
  const agentCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const s of recent) if (!hiddenStates.has(s.state)) c.set(s.agent_type, (c.get(s.agent_type) ?? 0) + 1);
    for (const a of hiddenAgents) if (!c.has(a)) c.set(a, 0);
    return [...c].sort((a, b) => b[1] - a[1]);
  }, [recent, hiddenStates, hiddenAgents]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => (needle ? new Set(visible.filter((s) => s.title.toLowerCase().includes(needle) || (s.line ?? "").toLowerCase().includes(needle) || s.repo.toLowerCase().includes(needle) || (s.task?.shortId ?? "").toLowerCase() === needle).map((s) => s.id)) : null), [visible, needle]);

  // The org's shape (roles, people, reporting lines) is drawn only when grouping by org.
  const orgRoles = group === "org" ? roles : NO_ROLES;
  const orgPeople = group === "org" ? people : NO_PEOPLE;
  const { base, edges, piles } = useMemo(() => {
    const { piles, loose } = buildPiles(visible, orgRoles, layout, view, now);
    const spots = defaultPositions(piles, orgPeople, orgRoles, loose, order);
    const at = (id: string) => { const p = layout.pos?.[id]; return p ? { x: p[0], y: p[1] } : spots[id] ?? { x: 0, y: 0 }; };
    const nodes: Node[] = [];
    for (const u of orgPeople) nodes.push({ id: personNodeId(u.id), type: "person", position: at(personNodeId(u.id)), data: { person: u } satisfies PersonData, width: PERSON.w, height: PERSON.h, selectable: false });
    for (const p of piles) {
      const { w, h } = pileSize(p);
      const { sessions: cards, settledTile } = pileCards(p);
      // Piles the person made sit above the automatic ones, each pile's cards just above it.
      const z = p.kind === "custom" ? 10 : 0;
      const anyMatch = !matches || cards.some((s) => matches.has(s.id)) || p.title.toLowerCase().includes(needle);
      // A pile's body lets the pointer through, so a selection box can start inside it; its header still grabs.
      nodes.push({ id: p.id, type: "pile", position: at(p.id), data: { pile: p, dim: !anyMatch, renaming: renaming === p.id, edit } satisfies PileData, width: w, height: h, dragHandle: ".map-pile-head", selectable: false, zIndex: z, style: PASS_THROUGH });
      if (p.folded) continue;
      cards.forEach((s, i) => nodes.push({ id: cardNodeId(s.id), type: "card", parentId: p.id, position: cardSlot(p, i), data: { s, dim: !!matches && !matches.has(s.id) } satisfies CardData, width: CARD.w, height: CARD.h, zIndex: z + 1 }));
      if (settledTile) nodes.push({ id: `${p.id}:${SETTLED_TILE}`, type: "tile", parentId: p.id, position: cardSlot(p, cards.length), data: { pile: p, dim: !!matches, edit } satisfies TileData, width: CARD.w, height: CARD.h, draggable: false, selectable: false, zIndex: z + 1 });
    }
    for (const s of loose) nodes.push({ id: cardNodeId(s.id), type: "card", position: at(cardNodeId(s.id)), data: { s, dim: !!matches && !matches.has(s.id) } satisfies CardData, width: CARD.w, height: CARD.h, zIndex: 20 });
    const present = new Set(nodes.map((n) => n.id));
    const edges: Edge[] = orgRoles
      .filter((r) => r.parent && present.has(r.parent) && present.has(rolePileId(r.id)))
      .map((r) => ({ id: `${r.parent}->${r.id}`, source: r.parent!, target: rolePileId(r.id), type: "smoothstep", selectable: false, focusable: false, style: { stroke: "color-mix(in srgb, var(--sol-violet) 55%, transparent)", strokeWidth: 2 } }));
    return { base: nodes, edges, piles };
  }, [visible, orgRoles, orgPeople, layout, view, order, now, matches, needle, renaming, edit]);

  // Keep the selection across rebuilds (a sync, a filter): only the cards still drawn stay selected.
  const selectedRef = useRef<ReadonlySet<string>>(new Set());
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(base);
  // A rebuild keeps each node's measured size, so React Flow does not lay out every node again.
  const rebuild = useCallback(() => setNodes((prev) => {
    const was = new Map(prev.map((n) => [n.id, n.measured]));
    return base.map((n) => ({ ...n, measured: was.get(n.id), selected: n.type === "card" && selectedRef.current.has(n.id) }));
  }), [base, setNodes]);
  useWatchEffect(() => { rebuild(); }, [rebuild]);

  const onViewport = useCallback((v: Viewport) => wrap.current?.style.setProperty("--mapz", String(v.zoom)), []);
  const onViewportEnd = useCallback((v: Viewport) => { try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify(v)); } catch {} }, []);
  useOnViewportChange({ onChange: onViewport, onEnd: onViewportEnd });
  const onSelection = useCallback(({ nodes: sel }: { nodes: Node[] }) => {
    const cards = sel.filter((n) => n.type === "card");
    selectedRef.current = new Set(cards.map((n) => n.id));
    setSelected(cards.map((n) => n.id.slice(2)));
  }, []);
  useOnSelectionChange({ onChange: onSelection });
  const select = useCallback((ids: readonly string[]) => {
    const want = new Set(ids.map(cardNodeId));
    // Before the change lands: a layout save in the same gesture rebuilds the nodes from this ref.
    selectedRef.current = want;
    flow.setNodes((ns) => ns.map((n) => (n.type === "card" && !!n.selected !== want.has(n.id) ? { ...n, selected: want.has(n.id) } : n)));
  }, [flow]);

  /** The topmost pile, person or loose card under a flow point, skipping what is being dragged. */
  const targetAt = useCallback((p: { x: number; y: number }, skip: Set<string>) => {
    let hit: Node | null = null;
    for (const n of flow.getNodes()) {
      if (skip.has(n.id) || n.parentId || !(n.type === "pile" || n.type === "person" || n.type === "card")) continue;
      const w = n.width ?? 0, h = n.height ?? 0;
      if (p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h) {
        if (!hit || n.type === "card") hit = n;
      }
    }
    return hit;
  }, [flow]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const titleOf = useCallback((ids: string[]) => (ids.length === 1 ? byId.get(ids[0])?.title ?? "Session" : `${ids.length} sessions`), [byId]);
  /** Ask before sessions report somewhere new; the confirm sits where the gesture happened. */
  const askAssign = useCallback((ids: string[], target: OrgReparentRequest["target"], targetTitle: string, at: { x: number; y: number }, pileId: string) => {
    setPending({ req: { subject: { kind: "session", id: ids[0], title: titleOf(ids) }, target, targetTitle, at }, ids, pileId });
  }, [titleOf]);

  const onNodeDragStop = useCallback((event: ReactMouseEvent, _node: Node, dragged: Node[]) => {
    let next = current();
    const frames = dragged.filter((n) => n.type === "pile" || n.type === "person");
    if (frames.length) next = placeNodes(next, frames.map((n) => ({ id: n.id, ...n.position })));
    const cards = dragged.filter((n) => n.type === "card");
    if (cards.length) {
      const ids = cards.map((n) => n.id.slice(2));
      const p = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const hit = targetAt(p, new Set(cards.map((n) => n.id)));
      const at = { x: event.clientX, y: event.clientY };
      const role = hit?.type === "pile" ? (hit.data as PileData).pile.role : undefined;
      if (role && ids.some((id) => byId.get(id)?.roleId !== role.id)) {
        // A different role: the sessions would report there. Ask first.
        askAssign(ids, { kind: "role", role_id: role.id }, role.name, at, hit!.id);
        rebuild();
        return save(next);
      }
      if (hit?.type === "person") {
        const person = (hit.data as PersonData).person;
        askAssign(ids, { kind: "user", user_id: person.id }, person.name, at, "");
        rebuild();
        return save(next);
      }
      if (hit?.type === "pile") next = moveToPile(next, ids, hit.id);
      else if (hit?.type === "card") {
        const key = newKey();
        next = createPile(next, "New pile", [hit.id.slice(2), ...ids], hit.position, key);
        setRenaming(customPileId(key));
      }
      else next = makeLoose(next, cards.map((n) => ({ id: n.id.slice(2), ...(flow.getInternalNode(n.id)?.internals.positionAbsolute ?? n.position) })));
    }
    if (next === current()) rebuild();
    else save(next);
  }, [flow, targetAt, byId, askAssign, save, rebuild]);

  const confirmMove = useCallback(() => {
    if (!pending) return;
    const { req, ids, pileId } = pending;
    setPending(null);
    const st = useInboxStore.getState();
    // Out of any pile the person made, so each lands with its new parent.
    save(moveToPile(current(), ids, pileId));
    for (const id of ids) {
      void st.reparentOrgSession(id, req.target.kind === "role" ? { kind: "role", role_id: req.target.role_id } : { kind: "user", user_id: req.target.user_id })
        .then((r) => { if (r && ids.length === 1) toast.success(reparentToastLine(req.subject.title, req.targetTitle, "session", r.told)); })
        .catch(() => {});
    }
    if (ids.length > 1) toast.success(`${ids.length} sessions now report to ${req.targetTitle}.`);
  }, [pending, save]);

  /** The free spot nearest `near` for a new pile: never on top of a pile, person or loose card. */
  // Every pile wears its name above its body when zoomed out, so a pile's box reaches up by that band, the new one's too.
  const openSpot = useCallback((near: { x: number; y: number }, size: { w: number; h: number }) => {
    const taken = flow.getNodes().filter((n) => !n.parentId && !(n.type === "card" && n.selected)).map((n) => {
      const band = n.type === "pile" ? TITLE_BAND : 0;
      return { x: n.position.x, y: n.position.y - band, w: n.width ?? 0, h: (n.height ?? 0) + band };
    });
    const spot = freeSpot(taken, { w: size.w, h: size.h + TITLE_BAND }, { x: near.x, y: near.y - TITLE_BAND });
    return { x: spot.x, y: spot.y + TITLE_BAND };
  }, [flow]);

  /** Pile (or stack) the selection where its first card sits, and name it at once. */
  const pileSelection = useCallback((stack: boolean) => {
    if (!selected.length) return;
    const bounds = flow.getNodesBounds(selected.map(cardNodeId).filter((id) => flow.getNode(id)));
    const key = newKey();
    const title = needle && matches?.size === selected.length ? query.trim() : stack ? "Stack" : "New pile";
    save(createPile(current(), title, selected, openSpot(bounds, newPileSize(selected.length, stack)), key, stack));
    setRenaming(customPileId(key));
    select([]);
  }, [selected, flow, save, needle, matches, query, select]);

  const pileMatches = useCallback(() => {
    if (!matches?.size) return;
    const ids = [...matches];
    const bounds = flow.getNodesBounds(ids.map(cardNodeId).filter((id) => flow.getNode(id)));
    save(createPile(current(), query.trim(), ids, openSpot(bounds, newPileSize(ids.length, false)), newKey()));
    setQuery("");
  }, [matches, flow, save, query]);

  const fitSelection = useCallback(() => {
    const ids = selected.length ? selected.map(cardNodeId) : null;
    void flow.fitView({ nodes: ids?.filter((id) => flow.getNode(id)).map((id) => ({ id })), padding: 0.12, maxZoom: 1.15, duration: 450 });
  }, [selected, flow]);

  const allPinned = useMemo(() => selected.length > 0 && selected.every((id) => useInboxStore.getState().sessions[id]?.is_pinned), [selected, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useMemo<SelectionActions>(() => ({
    pile: () => pileSelection(false),
    stack: () => pileSelection(true),
    moveTo: (pileId) => { save(moveToPile(current(), selected, pileId)); select([]); },
    assign: (role) => askAssign(selected, { kind: "role", role_id: role.id }, role.name, { x: window.innerWidth / 2, y: window.innerHeight - 220 }, rolePileId(role.id)),
    pin: () => {
      const st = useInboxStore.getState();
      // One gesture sets every card the same way: pin the unpinned, or unpin all when all are pinned.
      for (const id of selected) if (!!st.sessions[id]?.is_pinned === allPinned) st.pinSession(id);
    },
    stash: () => { void animatedHideSessions(selected, "stash"); select([]); },
    open: () => router.push(`/conversation/${selected[0]}`),
    fit: fitSelection,
    clear: () => select([]),
  }), [pileSelection, save, selected, select, askAssign, allPinned, router, fitSelection]);

  // Keys on the canvas; never while typing (a composer, the search, a rename).
  useEventListener("keydown", (e) => {
    if (keyBelongsElsewhere(e.target) || pending) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape" && selected.length) { e.preventDefault(); select([]); }
    else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      select(flow.getNodes().filter((n) => n.type === "card" && !(n.data as CardData).dim).map((n) => n.id.slice(2)));
    }
    else if (!mod && e.key.toLowerCase() === "f") { e.preventDefault(); fitSelection(); }
    else if (!mod && selected.length && e.key.toLowerCase() === "p") { e.preventDefault(); pileSelection(false); }
    else if (!mod && selected.length && e.key.toLowerCase() === "s") { e.preventDefault(); pileSelection(true); }
  });

  const pileIds = useMemo(() => piles.map((p) => p.id), [piles]);
  const mostlyFolded = piles.length > 0 && piles.filter((p) => p.folded).length * 2 >= piles.length;
  const customPiles = useMemo(() => piles.filter((p) => p.kind === "custom").map((p) => ({ id: p.id, title: p.title })), [piles]);
  const toggleState = (st: WorkState) => setView({ hiddenStates: hiddenStates.has(st) ? [...hiddenStates].filter((x) => x !== st) : [...hiddenStates, st] });
  const [initialViewport] = useState(readViewport);

  return (
    <div ref={wrap} className="relative h-full w-full" style={{ background: "var(--sol-bg)" }} data-session-map>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onInit={(f) => wrap.current?.style.setProperty("--mapz", String(f.getViewport().zoom))}
        onNodeDoubleClick={(e, n) => {
          // Double-click a card to work in it, a pile's header to take in the pile.
          if (n.type === "card") void flow.fitView({ nodes: [{ id: n.id }], maxZoom: 1.15, padding: 0.15, duration: 450 });
          else if (n.type === "pile" && (e.target as HTMLElement).closest(".map-pile-head")) void flow.fitView({ nodes: [{ id: n.id }], maxZoom: 1, padding: 0.08, duration: 450 });
        }}
        colorMode={theme === "dark" ? "dark" : "light"}
        defaultViewport={initialViewport}
        fitView={!initialViewport}
        fitViewOptions={FIT_ALL}
        minZoom={0.02}
        maxZoom={2}
        // A drag on bare canvas draws a selection box; the wheel or trackpad pans, pinch zooms,
        // and space, the middle or the right button drags the canvas.
        panOnScroll
        selectionOnDrag
        panOnDrag={PAN_BUTTONS}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode={null}
        multiSelectionKeyCode={MULTI_KEYS}
        selectNodesOnDrag={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} bgColor="transparent" color="color-mix(in srgb, var(--sol-border) 45%, transparent)" />
        <Controls showInteractive={false} position="bottom-left" className="!shadow-none !border !rounded-lg overflow-hidden" style={{ borderColor: HAIRLINE }} />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeStrokeWidth={0}
          nodeColor={(n) => n.type === "card" ? ORG_STATE_META[(n.data as CardData).s.state].color : n.type === "person" ? "var(--sol-cyan)" : (n.data as PileData)?.pile?.kind === "role" ? "color-mix(in srgb, var(--sol-violet) 35%, transparent)" : "color-mix(in srgb, var(--sol-border) 45%, transparent)"}
          maskColor="color-mix(in srgb, var(--sol-bg) 70%, transparent)"
          style={{ background: "var(--sol-bg-alt)", border: `1px solid ${HAIRLINE}`, borderRadius: 10 }}
        />
      </ReactFlow>

      {/* The canvas fades out under the controls, so nothing reads through them. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[9] h-[104px]" style={{ background: "linear-gradient(var(--sol-bg) 72%, transparent)" }} />
      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="pointer-events-auto flex h-8 w-[220px] items-center gap-2 rounded-lg border px-2.5" style={{ background: "var(--sol-card)", borderColor: HAIRLINE }}>
            <Search className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} placeholder="Find sessions" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" style={{ color: "var(--sol-text)" }} data-map-search />
            {matches && <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{matches.size}</span>}
          </label>
          {matches && matches.size > 0 && (
            <>
              <ToolButton onClick={() => select([...matches])} icon={<MousePointer2 className="h-3.5 w-3.5" />} data-map-select-matches>Select {matches.size}</ToolButton>
              <ToolButton onClick={pileMatches} icon={<Layers className="h-3.5 w-3.5" />} data-map-pile-matches>Pile {matches.size}</ToolButton>
            </>
          )}
          <ViewMenu name="Group" value={group} options={GROUPS} onChange={(g) => setView({ group: g, order: undefined })} data-map-group={group} />
          <ViewMenu name="Sort" value={view.sort ?? "urgency"} options={SORTS} onChange={(v) => setView({ sort: v })} data-map-sort={view.sort ?? "urgency"} />
          <ViewMenu name="Piles" value={order} options={ORDERS} onChange={(v) => setView({ order: v })} data-map-order={order} />
          <span className="flex-1" />
          <ToolButton onClick={() => save(setFolded(current(), pileIds, !mostlyFolded))} disabled={!piles.length} icon={mostlyFolded ? <Rows3 className="h-3.5 w-3.5" /> : <SquareStack className="h-3.5 w-3.5" />} data-map-fold-all={mostlyFolded ? "spread" : "stack"}>{mostlyFolded ? "Spread all" : "Stack all"}</ToolButton>
          <ToolButton onClick={undo} disabled={!history.length} icon={<Undo2 className="h-3.5 w-3.5" />} data-map-undo>Undo</ToolButton>
          <ToolButton onClick={() => save(tidy(current()))} disabled={!Object.keys(layout.pos ?? {}).length} icon={<LayoutGrid className="h-3.5 w-3.5" />} tip="Put every pile back in its default place" data-map-tidy>Tidy</ToolButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="pointer-events-auto flex h-8 items-center gap-0.5 rounded-lg border p-[3px]" style={{ background: "var(--sol-card)", borderColor: HAIRLINE }} role="group" aria-label="Show sessions by state">
            {STATE_ORDER.map((state) => {
              const n = stateCounts.find(([s]) => s === state)?.[1] ?? 0;
              const on = !hiddenStates.has(state);
              return (
                <button key={state} type="button" aria-pressed={on} onClick={() => toggleState(state)} className={cn("flex h-full items-center gap-1.5 rounded-md px-2 text-[11.5px] tabular-nums transition-colors", on ? "hover:bg-sol-bg-highlight/60" : "opacity-40 hover:opacity-70")} style={{ color: "var(--sol-text)" }} title={`${on ? "Hide" : "Show"} ${ORG_STATE_META[state].label}`} data-map-state={state}>
                  <StateDot state={state} />
                  {ORG_STATE_META[state].label} {n}
                </button>
              );
            })}
          </div>
          <ViewMenu name="Active" value={since} options={SINCES} onChange={(v) => setView({ since: v })} data-map-since={since} />
          <AgentMenu
            agents={agentCounts}
            hidden={hiddenAgents}
            onToggle={(a) => setView({ hiddenAgents: hiddenAgents.has(a) ? [...hiddenAgents].filter((x) => x !== a) : [...hiddenAgents, a] })}
            onOnly={() => setView({ hiddenAgents: [] })}
          />
          <span className="text-[11.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{visible.length} of {sessions.length}</span>
        </div>
      </div>
      {selected.length > 0 && !pending && <SelectionBar count={selected.length} allPinned={allPinned} piles={customPiles} roles={roles} act={act} />}
      {pending && <MoveConfirm req={pending.req} onConfirm={confirmMove} onCancel={() => { setPending(null); rebuild(); }} />}
    </div>
  );
}

export function SessionMap() {
  return (
    <ReactFlowProvider>
      <SessionMapInner />
    </ReactFlowProvider>
  );
}
