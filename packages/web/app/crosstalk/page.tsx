"use client";
// Crosstalk — a live view of what your agents are saying to each other. Every
// `cast send` from one session to another is a durable row in pending_messages;
// this page reads that ledger, draws the network of who-talks-to-whom as an
// animated constellation, and streams the actual messages alongside it.
import { useMemo, useState, useCallback, Component, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useTrackedStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import {
  SessionConstellation,
  hueFor,
  type GNode,
  type GEdge,
} from "../../components/SessionConstellation";
import {
  Radio,
  ArrowRight,
  Check,
  AlertTriangle,
  X,
  CornerDownRight,
  Users,
  Sparkles,
} from "lucide-react";

const api = _api as any;

type Link0 = {
  _id: string;
  created_at: number;
  delivered_at: number | null;
  status: string;
  retry_count: number;
  from_id: string;
  to_id: string;
  from_short: string | null;
  from_user_id: string;
  cross_user: boolean;
  body: string;
};
type Node0 = {
  _id: string;
  short_id: string;
  title: string | null;
  project_path: string | null;
  agent_type: string | null;
  message_count: number;
  updated_at: number;
  status: string | null;
  user_id: string | null;
  is_subagent: boolean;
  resolved: boolean;
};

const GRAPH_NODE_CAP = 60;

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 0) return "now";
  const s = Math.floor(d / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function dayKey(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

const STATUS_META: Record<string, { icon: any; tint: string; label: string }> = {
  delivered: { icon: Check, tint: "text-sol-green", label: "delivered" },
  injected: { icon: CornerDownRight, tint: "text-sol-cyan", label: "injected" },
  pending: { icon: Radio, tint: "text-sol-yellow", label: "in flight" },
  failed: { icon: AlertTriangle, tint: "text-sol-red", label: "failed" },
  undeliverable: { icon: AlertTriangle, tint: "text-sol-orange", label: "undeliverable" },
  cancelled: { icon: X, tint: "text-sol-text-dim", label: "cancelled" },
};

// The backend query lives in a shared, multi-session Convex deployment; while this
// feature is uncommitted, another session's `convex dev` can momentarily push a
// function set without it, making the query 404. Rather than let that throw all the
// way to the route-level boundary ("Crosstalk crashed"), catch it here and show a
// calm reconnecting state that re-mounts itself every few seconds — so the page
// heals the instant the function is back.
class CrosstalkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  timer: any = null;
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.setState({ failed: false }), 4000);
  }
  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }
  retry = () => {
    if (this.timer) clearTimeout(this.timer);
    this.setState({ failed: false });
  };
  render() {
    if (this.state.failed) return <CrosstalkReconnecting onRetry={this.retry} />;
    return this.props.children;
  }
}

export default function CrosstalkPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <CrosstalkBoundary>
          <CrosstalkInner />
        </CrosstalkBoundary>
      </DashboardLayout>
    </AuthGuard>
  );
}

function CrosstalkReconnecting({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="h-full flex flex-col bg-sol-bg text-sol-text overflow-hidden">
      <Header model={null} />
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center max-w-xs px-6">
          <Radio className="w-8 h-8 text-sol-cyan animate-pulse" />
          <div className="text-sm font-medium">Reconnecting to the signal…</div>
          <p className="text-[12.5px] text-sol-text-muted leading-relaxed">
            The crosstalk feed briefly lost its backend connection. Retrying automatically.
          </p>
          <button
            onClick={onRetry}
            className="mt-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-sol-card border border-sol-border/30 hover:border-sol-border/60 transition-colors"
          >
            Retry now
          </button>
        </div>
      </div>
    </div>
  );
}

function CrosstalkInner() {
  const router = useRouter();
  const data = useQuery(api.sessionThreads.listSessionThreads, {}) as
    | { links: Link0[]; nodes: Node0[]; generatedAt: number }
    | undefined;

  const s = useTrackedStore([
    (st) => st.sessions,
    (st) => st.teamMembers,
    (st) => st.currentUser,
  ]);

  const [selected, setSelected] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState<string | null>(null);

  // Build the graph model: live-status overlay from the store, node weights,
  // and edges aggregated per ordered session pair.
  const model = useMemo(() => {
    if (!data) return null;
    const now = Date.now();
    const nodeById = new Map(data.nodes.map((n) => [n._id, n]));

    const sent = new Map<string, number>();
    const recv = new Map<string, number>();
    const edgeMap = new Map<string, GEdge>();
    for (const l of data.links) {
      sent.set(l.from_id, (sent.get(l.from_id) ?? 0) + 1);
      recv.set(l.to_id, (recv.get(l.to_id) ?? 0) + 1);
      if (l.from_id === l.to_id) continue; // skip self-talk in the graph
      const k = `${l.from_id}__${l.to_id}`;
      let e = edgeMap.get(k);
      if (!e) {
        e = {
          from: l.from_id,
          to: l.to_id,
          count: 0,
          lastAt: 0,
          key: k.replace(/[^a-zA-Z0-9_]/g, "-"),
        };
        edgeMap.set(k, e);
      }
      e.count += 1;
      e.lastAt = Math.max(e.lastAt, l.created_at);
    }

    const liveIds = new Set<string>();
    const allNodes: GNode[] = data.nodes.map((n) => {
      const ses: any = (s.sessions as any)?.[n._id];
      const live =
        (ses && ses.is_active && !ses.is_idle) ||
        (n.status === "active" && now - n.updated_at < 1000 * 60 * 3);
      if (live) liveIds.add(n._id);
      return {
        id: n._id,
        shortId: n.short_id,
        title: n.title,
        projectPath: n.project_path,
        weight: (sent.get(n._id) ?? 0) + (recv.get(n._id) ?? 0),
        hue: hueFor(n._id),
        live,
        resolved: n.resolved,
        isSubagent: n.is_subagent,
      };
    });

    // Cap the constellation to the most-active sessions for legibility; the
    // stream still shows every message.
    const topNodes = [...allNodes].sort((a, b) => b.weight - a.weight).slice(0, GRAPH_NODE_CAP);
    const keep = new Set(topNodes.map((n) => n.id));
    const edges = [...edgeMap.values()].filter((e) => keep.has(e.from) && keep.has(e.to));

    // Busiest pair (combine both directions).
    let busiest: { a: string; b: string; count: number } | null = null;
    const pairCount = new Map<string, number>();
    for (const e of edgeMap.values()) {
      const [a, b] = [e.from, e.to].sort();
      const pk = `${a}__${b}`;
      const c = (pairCount.get(pk) ?? 0) + e.count;
      pairCount.set(pk, c);
      if (!busiest || c > busiest.count) busiest = { a, b, count: c };
    }

    return {
      nodes: topNodes,
      edges,
      liveIds,
      nodeById,
      totalMessages: data.links.length,
      talkers: allNodes.filter((n) => n.weight > 0).length,
      liveCount: liveIds.size,
      busiest,
    };
  }, [data, s.sessions]);

  // Stream: newest first, optionally filtered to the selected session.
  const stream = useMemo(() => {
    if (!data) return [];
    const ls = [...data.links].sort((a, b) => b.created_at - a.created_at);
    if (!selected) return ls;
    return ls.filter((l) => l.from_id === selected || l.to_id === selected);
  }, [data, selected]);

  const onOpen = useCallback(
    (id: string) => {
      if (id.startsWith("ghost:")) return;
      router.push(`/conversation/${id}`);
    },
    [router]
  );

  const nodeTitle = useCallback(
    (id: string) => {
      const n = model?.nodeById.get(id);
      return n?.title || n?.short_id || id.slice(0, 7);
    },
    [model]
  );

  return (
    <div className="h-full flex flex-col bg-sol-bg text-sol-text overflow-hidden">
      <Header model={model} />
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
            {/* Constellation */}
            <div className="relative lg:w-[58%] h-[44vh] lg:h-auto border-b lg:border-b-0 lg:border-r border-sol-border/15 bg-gradient-to-b from-sol-bg-alt/30 to-sol-bg">
              {model && model.nodes.length > 0 ? (
                <>
                  <SessionConstellation
                    nodes={model.nodes}
                    edges={model.edges}
                    selectedId={selected}
                    pulseKey={pulseKey}
                    onSelect={setSelected}
                    onOpen={onOpen}
                  />
                  <div className="pointer-events-none absolute bottom-3 left-4 text-[11px] text-sol-text-dim font-mono">
                    click a node to filter · double-click to open
                  </div>
                  {model.nodes.length >= GRAPH_NODE_CAP && (
                    <div className="pointer-events-none absolute top-3 right-4 text-[11px] text-sol-text-dim">
                      showing {GRAPH_NODE_CAP} busiest sessions
                    </div>
                  )}
                </>
              ) : (
                <GraphEmpty loading={!data} />
              )}
            </div>

            {/* Stream */}
            <div className="lg:w-[42%] flex flex-col min-h-0">
              <div className="flex items-center justify-between px-4 h-11 border-b border-sol-border/15 flex-shrink-0">
                <div className="flex items-center gap-2 text-xs font-medium text-sol-text-muted">
                  <Radio className="w-3.5 h-3.5 text-sol-cyan" />
                  {selected ? (
                    <span className="flex items-center gap-1.5">
                      filtered to
                      <span
                        className="font-semibold text-sol-text truncate max-w-[180px]"
                        style={{ color: hueFor(selected) }}
                      >
                        {nodeTitle(selected)}
                      </span>
                    </span>
                  ) : (
                    <span>{stream.length} messages</span>
                  )}
                </div>
                {selected && (
                  <button
                    onClick={() => setSelected(null)}
                    className="flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
                  >
                    <X className="w-3 h-3" /> clear
                  </button>
                )}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto" data-main-scroll>
                {!data ? (
                  <StreamSkeleton />
                ) : stream.length === 0 ? (
                  <StreamEmpty hasAny={(data.links.length ?? 0) > 0} />
                ) : (
                  <MessageStream
                    links={stream}
                    nodeById={model?.nodeById ?? new Map()}
                    teamMembers={s.teamMembers}
                    onPulse={setPulseKey}
                    onSelectNode={setSelected}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
  );
}

function Header({ model }: { model: any }) {
  return (
    <div className="flex-shrink-0 px-5 sm:px-7 pt-5 pb-4 border-b border-sol-border/15">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1
            className="text-[28px] leading-none font-semibold tracking-tight flex items-center gap-2.5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <span className="relative inline-flex">
              <Radio className="w-6 h-6 text-sol-cyan" strokeWidth={1.75} />
            </span>
            Crosstalk
          </h1>
          <p className="mt-1.5 text-[13px] text-sol-text-muted">
            What your agents are saying to each other — every{" "}
            <span className="font-mono text-sol-text-dim">cast send</span> between sessions.
          </p>
        </div>
        {model && (
          <div className="flex items-center gap-2">
            <StatChip icon={ArrowRight} value={model.totalMessages} label="messages" tint="text-sol-blue" />
            <StatChip icon={Users} value={model.talkers} label="sessions talking" tint="text-sol-violet" />
            <StatChip
              icon={Sparkles}
              value={model.liveCount}
              label="live now"
              tint="text-sol-green"
              pulse={model.liveCount > 0}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function StatChip({
  icon: Icon,
  value,
  label,
  tint,
  pulse,
}: {
  icon: any;
  value: number;
  label: string;
  tint: string;
  pulse?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sol-card border border-sol-border/20">
      <Icon className={`w-3.5 h-3.5 ${tint} ${pulse ? "animate-pulse" : ""}`} />
      <div className="leading-none">
        <span className="text-base font-semibold tabular-nums">{value}</span>
        <span className="ml-1.5 text-[11px] text-sol-text-dim">{label}</span>
      </div>
    </div>
  );
}

function SessionPill({
  id,
  nodeById,
  onSelectNode,
}: {
  id: string;
  nodeById: Map<string, Node0>;
  onSelectNode: (id: string) => void;
}) {
  const n = nodeById.get(id);
  const hue = hueFor(id);
  const title = n?.title || (n?.resolved ? "Untitled" : n?.short_id || id.slice(0, 7));
  const ghost = !n?.resolved;
  const inner = (
    <span
      className="group inline-flex items-center gap-1.5 max-w-[44%] rounded-md px-1.5 py-0.5 border transition-colors"
      style={{
        borderColor: `${hue}40`,
        background: `${hue}0f`,
      }}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ghost ? "transparent" : hue, border: ghost ? `1.5px dashed ${hue}` : undefined }} />
      <span className="truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>
        {title}
      </span>
      <span className="font-mono text-[10px] text-sol-text-dim flex-shrink-0">{n?.short_id ?? id.slice(0, 7)}</span>
    </span>
  );
  if (ghost || !n) {
    return (
      <button onClick={() => onSelectNode(id)} title="Filter to this session">
        {inner}
      </button>
    );
  }
  return (
    <Link href={`/conversation/${id}`} onClick={(e) => e.stopPropagation()} title="Open session">
      {inner}
    </Link>
  );
}

function MessageStream({
  links,
  nodeById,
  teamMembers,
  onPulse,
  onSelectNode,
}: {
  links: Link0[];
  nodeById: Map<string, Node0>;
  teamMembers: any[] | null | undefined;
  onPulse: (key: string | null) => void;
  onSelectNode: (id: string) => void;
}) {
  // Group consecutive messages by day.
  const groups: { day: string; items: Link0[] }[] = [];
  for (const l of links) {
    const day = dayKey(l.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(l);
    else groups.push({ day, items: [l] });
  }

  return (
    <div className="px-3 sm:px-4 py-3">
      {groups.map((g) => (
        <div key={g.day} className="mb-1">
          <div className="sticky top-0 z-10 -mx-3 sm:-mx-4 px-4 py-1.5 bg-sol-bg/85 backdrop-blur-sm">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim">
              {g.day}
            </span>
          </div>
          <div className="flex flex-col gap-2 pt-1">
            {g.items.map((l) => (
              <MessageCard
                key={l._id}
                link={l}
                nodeById={nodeById}
                teamMembers={teamMembers}
                onPulse={onPulse}
                onSelectNode={onSelectNode}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="h-8" />
    </div>
  );
}

function MessageCard({
  link,
  nodeById,
  teamMembers,
  onPulse,
  onSelectNode,
}: {
  link: Link0;
  nodeById: Map<string, Node0>;
  teamMembers: any[] | null | undefined;
  onPulse: (key: string | null) => void;
  onSelectNode: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[link.status] ?? STATUS_META.delivered;
  const StatusIcon = meta.icon;
  const edgeKey = `${link.from_id}__${link.to_id}`.replace(/[^a-zA-Z0-9_]/g, "-");
  const hue = hueFor(link.from_id);

  const sender = teamMembers?.find((m) => m && m._id === link.from_user_id);
  const senderName = sender?.name || sender?.email?.split("@")[0];

  const body = link.body || "";
  const long = body.length > 320;
  const shown = expanded || !long ? body : body.slice(0, 300).trimEnd() + "…";

  return (
    <div
      className="group relative rounded-xl border border-sol-border/15 bg-sol-card hover:border-sol-border/35 transition-colors overflow-hidden"
      onMouseEnter={() => onPulse(edgeKey)}
      onMouseLeave={() => onPulse(null)}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ background: hue, opacity: 0.7 }}
      />
      <div className="pl-3.5 pr-3 py-2.5">
        <div className="flex items-center gap-1.5 text-sol-text">
          <SessionPill id={link.from_id} nodeById={nodeById} onSelectNode={onSelectNode} />
          <ArrowRight className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
          <SessionPill id={link.to_id} nodeById={nodeById} onSelectNode={onSelectNode} />
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {link.cross_user && senderName && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-sol-text-dim">
                <Users className="w-3 h-3" />
                {senderName}
              </span>
            )}
            <span
              className={`flex items-center gap-1 text-[10px] ${meta.tint}`}
              title={meta.label}
            >
              <StatusIcon className={`w-3 h-3 ${link.status === "pending" ? "animate-pulse" : ""}`} />
            </span>
            <span className="text-[11px] text-sol-text-dim tabular-nums whitespace-nowrap">
              {relTime(link.created_at)}
            </span>
          </div>
        </div>
        <div className="mt-1.5 text-[13px] leading-relaxed text-sol-text-secondary whitespace-pre-wrap break-words">
          {shown}
        </div>
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[11px] text-sol-blue hover:underline"
          >
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  );
}

function GraphEmpty({ loading }: { loading: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      {loading ? (
        <div className="flex flex-col items-center gap-3 text-sol-text-dim">
          <Radio className="w-8 h-8 animate-pulse text-sol-cyan" />
          <span className="text-sm">Tuning in…</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center max-w-xs px-6">
          <div className="w-14 h-14 rounded-2xl bg-sol-bg-alt flex items-center justify-center">
            <Radio className="w-7 h-7 text-sol-text-dim" />
          </div>
          <div className="text-sm font-medium text-sol-text">No crosstalk yet</div>
          <p className="text-[12.5px] text-sol-text-muted leading-relaxed">
            When one session messages another with{" "}
            <span className="font-mono text-sol-text-dim">cast send &lt;id&gt; "…"</span>, the
            conversation lights up here.
          </p>
        </div>
      )}
    </div>
  );
}

function StreamEmpty({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="h-full flex items-center justify-center text-center px-6">
      <p className="text-[12.5px] text-sol-text-muted leading-relaxed max-w-xs">
        {hasAny
          ? "No messages involve this session. Clear the filter to see everything."
          : "Nothing here yet — agents haven't sent each other any messages."}
      </p>
    </div>
  );
}

function StreamSkeleton() {
  return (
    <div className="px-4 py-4 flex flex-col gap-2.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-sol-border/15 bg-sol-card p-3 animate-pulse">
          <div className="flex items-center gap-2">
            <div className="h-4 w-24 rounded bg-sol-bg-highlight" />
            <div className="h-3 w-3 rounded bg-sol-bg-highlight" />
            <div className="h-4 w-24 rounded bg-sol-bg-highlight" />
          </div>
          <div className="mt-2 h-3 w-full rounded bg-sol-bg-highlight" />
          <div className="mt-1 h-3 w-2/3 rounded bg-sol-bg-highlight" />
        </div>
      ))}
    </div>
  );
}
