"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery, useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import Link from "next/link";
import {
  MessageSquare,
  FileText,
  Clock,
  GitBranch,
  FolderOpen,
  Tag,
  Inbox,
  Pickaxe,
  Loader2,
  Zap,
  Circle,
  CircleDot,
  CheckCircle2,
  XCircle,
  CircleDotDashed,
  User,
  Users,
} from "lucide-react";

type TypeFilter = "all" | "session" | "task" | "doc";
type OutcomeFilter = "all" | "shipped" | "progress" | "blocked";

const OUTCOME_COLORS: Record<string, { text: string; border: string; bg: string }> = {
  shipped: { text: "text-sol-green", border: "border-l-sol-green", bg: "bg-sol-green/5" },
  progress: { text: "text-sol-cyan", border: "border-l-sol-cyan", bg: "bg-sol-cyan/5" },
  blocked: { text: "text-sol-red", border: "border-l-sol-red", bg: "bg-sol-red/5" },
  unknown: { text: "text-sol-text-dim", border: "border-l-sol-text-dim", bg: "bg-sol-bg-alt/40" },
};

const STATUS_ICONS: Record<string, { icon: typeof Circle; color: string }> = {
  draft: { icon: CircleDotDashed, color: "text-sol-text-dim" },
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  in_review: { icon: CircleDot, color: "text-sol-violet" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  dropped: { icon: XCircle, color: "text-sol-text-dim" },
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  const days = Math.round(diff / 86400000);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dateGroup(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86400000) return "Yesterday";
  if (ts >= startOfToday - now.getDay() * 86400000) return "This Week";
  if (ts >= startOfToday - (now.getDay() + 7) * 86400000) return "Last Week";
  return new Date(ts).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function projectName(path?: string): string {
  if (!path) return "";
  return path.replace(/\/$/, "").split("/").pop() || path;
}

function ThemeTag({ theme, active, onClick }: { theme: string; active?: boolean; onClick?: (t: string) => void }) {
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick?.(theme); }}
      className={`text-[10px] px-1.5 rounded transition-colors ${
        active
          ? "bg-sol-cyan/20 text-sol-cyan border border-sol-cyan/30"
          : "bg-sol-bg-highlight text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/10"
      }`}
    >
      {theme}
    </button>
  );
}

function PersonBadge({ name }: { name?: string }) {
  if (!name) return null;
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-sol-text-dim" title={name}>
      <span className="w-4 h-4 rounded-full bg-sol-bg-highlight flex items-center justify-center text-[8px] font-medium">
        {initials}
      </span>
      {name.split(" ")[0]}
    </span>
  );
}

function SessionCard({ item, childTasks, childDocs, themeFilter, onThemeClick }: { item: any; childTasks?: any[]; childDocs?: any[]; themeFilter?: string | null; onThemeClick?: (t: string) => void }) {
  const d = item.data;
  const outcome = OUTCOME_COLORS[d.outcome_type] || OUTCOME_COLORS.unknown;
  const hasChildren = (childTasks && childTasks.length > 0) || (childDocs && childDocs.length > 0);

  return (
    <div>
      <Link href={`/conversation/${d.conversation_id}`} className="block group">
        <div className={`border-l-2 ${outcome.border} ${outcome.bg} hover:bg-sol-bg-alt/70 transition-colors ${hasChildren ? "rounded-tr-lg" : "rounded-r-lg"} px-4 py-3`}>
          <div className="flex items-start gap-3">
            <Zap className={`w-4 h-4 mt-0.5 flex-shrink-0 ${outcome.text}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-sol-text">
                  {d.conversation_title || d.goal || d.summary?.slice(0, 80) || "Session"}
                </span>
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${outcome.text} border-current/30`}>
                  {d.outcome_type}
                </Badge>
                <PersonBadge name={d.actor_name} />
              </div>
              {d.summary && (
                <p className="text-xs text-sol-text-muted mt-1 line-clamp-2">{d.summary}</p>
              )}
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                {d.project_path && (
                  <span className="flex items-center gap-1 text-[11px] text-sol-text-dim font-mono">
                    <FolderOpen className="w-3 h-3" />
                    {projectName(d.project_path)}
                  </span>
                )}
                {d.git_branch && d.git_branch !== "main" && (
                  <span className="flex items-center gap-1 text-[11px] text-sol-text-dim font-mono truncate max-w-[160px]">
                    <GitBranch className="w-3 h-3" />
                    {d.git_branch}
                  </span>
                )}
                {d.message_count != null && (
                  <span className="flex items-center gap-1 text-[11px] text-sol-text-dim">
                    <MessageSquare className="w-3 h-3" />
                    {d.message_count} msgs
                  </span>
                )}
                {d.themes?.length > 0 && (
                  <span className="flex items-center gap-1">
                    <Tag className="w-3 h-3 text-sol-text-dim" />
                    {d.themes.slice(0, 4).map((t: string) => (
                      <ThemeTag key={t} theme={t} active={themeFilter === t} onClick={onThemeClick} />
                    ))}
                  </span>
                )}
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim ml-auto">
                  <Clock className="w-3 h-3" />
                  {relativeTime(item.timestamp)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Link>
      {hasChildren && (
        <div className={`border-l-2 ${outcome.border} bg-sol-bg/50 rounded-br-lg pl-8 pr-4 py-1.5 space-y-0.5`}>
          {childTasks?.map((t: any) => {
            const si = STATUS_ICONS[t.data.status] || STATUS_ICONS.open;
            const Icon = si.icon;
            return (
              <Link key={t.data._id} href={`/tasks/${t.data._id}`} className="flex items-center gap-2 py-1 hover:bg-sol-bg-alt/30 rounded px-2 -mx-2 transition-colors">
                <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${si.color}`} />
                <span className="text-[11px] font-mono text-sol-text-dim">{t.data.short_id}</span>
                <span className="text-xs text-sol-text truncate">{t.data.title}</span>
                <Badge variant="outline" className={`text-[9px] px-1 py-0 ${si.color} border-current/30 ml-auto flex-shrink-0`}>
                  {t.data.status?.replace("_", " ")}
                </Badge>
              </Link>
            );
          })}
          {childDocs?.map((dc: any) => (
            <Link key={dc.data._id} href={`/docs/${dc.data._id}`} className="flex items-center gap-2 py-1 hover:bg-sol-bg-alt/30 rounded px-2 -mx-2 transition-colors">
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-sol-violet" />
              <span className="text-xs text-sol-text truncate">{dc.data.title}</span>
              <Badge variant="outline" className="text-[9px] px-1 py-0 text-sol-violet border-sol-violet/30 ml-auto flex-shrink-0">
                {dc.data.doc_type}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ item, themeFilter, onThemeClick }: { item: any; themeFilter?: string | null; onThemeClick?: (t: string) => void }) {
  const d = item.data;
  const si = STATUS_ICONS[d.status] || STATUS_ICONS.open;
  const Icon = si.icon;

  return (
    <Link href={`/tasks/${d._id}`} className="block group">
      <div className="border-l-2 border-l-sol-yellow/50 bg-sol-bg-alt/20 hover:bg-sol-bg-alt/60 transition-colors rounded-r-lg px-4 py-2.5">
        <div className="flex items-start gap-3">
          <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${si.color}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-sol-text-dim">{d.short_id}</span>
              <span className="text-sm text-sol-text">{d.title}</span>
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${si.color} border-current/30`}>
                {d.status?.replace("_", " ")}
              </Badge>
              {d.source === "insight" && (
                <span className="text-[10px] px-1.5 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20">mined</span>
              )}
              <PersonBadge name={d.actor_name} />
            </div>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {d.labels?.slice(0, 3).map((l: string) => (
                <ThemeTag key={l} theme={l} active={themeFilter === l} onClick={onThemeClick} />
              ))}
              {d.conversation_title && (
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim truncate max-w-[200px]">
                  <Zap className="w-3 h-3" />
                  {d.conversation_title}
                </span>
              )}
              <span className="flex items-center gap-1 text-[11px] text-sol-text-dim ml-auto">
                <Clock className="w-3 h-3" />
                {relativeTime(item.timestamp)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

function DocCard({ item, themeFilter, onThemeClick }: { item: any; themeFilter?: string | null; onThemeClick?: (t: string) => void }) {
  const d = item.data;

  return (
    <Link href={`/docs/${d._id}`} className="block group">
      <div className="border-l-2 border-l-sol-violet/50 bg-sol-bg-alt/20 hover:bg-sol-bg-alt/60 transition-colors rounded-r-lg px-4 py-2.5">
        <div className="flex items-start gap-3">
          <FileText className="w-4 h-4 mt-0.5 flex-shrink-0 text-sol-violet" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-sol-text">{d.title}</span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sol-violet border-sol-violet/30">
                {d.doc_type}
              </Badge>
              <PersonBadge name={d.actor_name} />
            </div>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {d.conversation_title && (
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim truncate max-w-[200px]">
                  <Zap className="w-3 h-3" />
                  {d.conversation_title}
                </span>
              )}
              {d.project_path && (
                <span className="flex items-center gap-1 text-[11px] text-sol-text-dim font-mono">
                  <FolderOpen className="w-3 h-3" />
                  {projectName(d.project_path)}
                </span>
              )}
              {d.labels?.slice(0, 3).map((l: string) => (
                <ThemeTag key={l} theme={l} active={themeFilter === l} onClick={onThemeClick} />
              ))}
              <span className="flex items-center gap-1 text-[11px] text-sol-text-dim ml-auto">
                <Clock className="w-3 h-3" />
                {relativeTime(item.timestamp)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function RoadmapPage() {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [themeFilter, setThemeFilter] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("all");
  const items = useQuery(api.taskMining.webGetRoadmap, {});
  const stats = useQuery(api.taskMining.webGetTeamStats, {});
  const mineAll = useAction(api.taskMining.webMineAll);
  const [mining, setMining] = useState(false);
  const [mineResult, setMineResult] = useState<any>(null);

  const handleMine = useCallback(async () => {
    setMining(true);
    setMineResult(null);
    try {
      const result = await mineAll({});
      setMineResult(result);
    } catch (e: any) {
      setMineResult({ error: e.message });
    } finally {
      setMining(false);
    }
  }, [mineAll]);

  // Extract unique people and projects for filters
  const { people, projects } = useMemo(() => {
    if (!items) return { people: [], projects: [] };
    const pSet = new Set<string>();
    const prSet = new Set<string>();
    for (const item of items) {
      const name = item.data?.actor_name;
      if (name) pSet.add(name);
      const proj = item.data?.project_path;
      if (proj) prSet.add(projectName(proj));
    }
    return {
      people: Array.from(pSet).sort(),
      projects: Array.from(prSet).sort(),
    };
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return null;
    return items.filter((item: any) => {
      if (typeFilter !== "all" && item.type !== typeFilter) return false;
      if (personFilter !== "all" && item.data?.actor_name !== personFilter) return false;
      if (projectFilter !== "all" && projectName(item.data?.project_path) !== projectFilter) return false;
      if (themeFilter) {
        const themes = item.data?.themes || item.data?.labels || [];
        if (!themes.includes(themeFilter)) return false;
      }
      if (outcomeFilter !== "all") {
        if (item.type === "session" && item.data?.outcome_type !== outcomeFilter) return false;
        // For tasks/docs, match based on their linked session's outcome
        if (item.type === "task") {
          const status = item.data?.status;
          if (outcomeFilter === "shipped" && status !== "done") return false;
          if (outcomeFilter === "blocked" && status !== "open") return false;
          if (outcomeFilter === "progress" && status !== "in_progress") return false;
        }
        if (item.type === "doc") return true; // docs always pass outcome filter
      }
      return true;
    });
  }, [items, typeFilter, personFilter, projectFilter, themeFilter, outcomeFilter]);

  // Group tasks/docs under their parent session by conversation_id
  const { groupedItems, childTaskMap, childDocMap } = useMemo(() => {
    if (!filtered) return { groupedItems: null, childTaskMap: new Map(), childDocMap: new Map() };

    // Build maps of conversation_id -> child tasks/docs
    const ctMap = new Map<string, any[]>();
    const cdMap = new Map<string, any[]>();
    const sessionConvIds = new Set<string>();

    // First pass: find all session conversation_ids
    for (const item of filtered) {
      if (item.type === "session" && item.data?.conversation_id) {
        sessionConvIds.add(item.data.conversation_id);
      }
    }

    // Second pass: assign tasks/docs to their parent sessions
    const topLevel: any[] = [];
    for (const item of filtered) {
      if (item.type === "task" && item.data?.created_from_conversation) {
        const convId = item.data.created_from_conversation;
        if (sessionConvIds.has(convId)) {
          if (!ctMap.has(convId)) ctMap.set(convId, []);
          ctMap.get(convId)!.push(item);
          continue;
        }
      }
      if (item.type === "doc" && item.data?.conversation_id) {
        const convId = item.data.conversation_id;
        if (sessionConvIds.has(convId)) {
          if (!cdMap.has(convId)) cdMap.set(convId, []);
          cdMap.get(convId)!.push(item);
          continue;
        }
      }
      topLevel.push(item);
    }

    return { groupedItems: topLevel, childTaskMap: ctMap, childDocMap: cdMap };
  }, [filtered]);

  const grouped = useMemo(() => {
    if (!groupedItems) return null;
    const groups: { label: string; items: any[] }[] = [];
    const groupMap = new Map<string, any[]>();
    const order: string[] = [];

    for (const item of groupedItems) {
      const label = dateGroup(item.timestamp);
      if (!groupMap.has(label)) {
        groupMap.set(label, []);
        order.push(label);
      }
      groupMap.get(label)!.push(item);
    }

    for (const label of order) {
      groups.push({ label, items: groupMap.get(label)! });
    }
    return groups;
  }, [groupedItems]);

  // Counts based on the filtered+grouped top-level items (not nested children)
  const counts = useMemo(() => {
    if (!groupedItems) return { session: 0, task: 0, doc: 0, total: 0 };
    return {
      session: groupedItems.filter((i: any) => i.type === "session").length,
      task: groupedItems.filter((i: any) => i.type === "task").length,
      doc: groupedItems.filter((i: any) => i.type === "doc").length,
      total: groupedItems.length,
    };
  }, [groupedItems]);

  return (
    <AuthGuard>
      <DashboardLayout hideSidebar>
        <div className="h-full flex flex-col">
          <div className="px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-sol-text tracking-tight">Roadmap</h1>
                {stats && (
                  <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {stats.members} members</span>
                    <span className="flex items-center gap-1"><Zap className="w-3 h-3" /> {stats.sessions} sessions</span>
                    <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> {stats.tasks} tasks</span>
                    {stats.tasksByStatus && (
                      <span className="flex items-center gap-1.5 text-[10px]">
                        {stats.tasksByStatus.done > 0 && <span className="text-sol-green">{stats.tasksByStatus.done} done</span>}
                        {stats.tasksByStatus.in_progress > 0 && <span className="text-sol-yellow">{stats.tasksByStatus.in_progress} active</span>}
                        {stats.tasksByStatus.open > 0 && <span className="text-sol-blue">{stats.tasksByStatus.open} open</span>}
                      </span>
                    )}
                    <span className="flex items-center gap-1"><FileText className="w-3 h-3" /> {stats.docs} docs</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {mineResult && !mineResult.error && (
                  <span className="text-xs text-sol-green">
                    +{mineResult.tasks_created ?? 0} tasks, +{mineResult.docs_created ?? 0} docs
                    ({mineResult.insights_processed ?? 0} insights, {mineResult.members_processed ?? 0} members)
                  </span>
                )}
                {mineResult?.error && (
                  <span className="text-xs text-sol-red truncate max-w-[200px]">{mineResult.error}</span>
                )}
                <button
                  onClick={handleMine}
                  disabled={mining}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-sol-border text-sol-text-muted hover:text-sol-text hover:border-sol-cyan transition-colors disabled:opacity-40"
                >
                  {mining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pickaxe className="w-3.5 h-3.5" />}
                  Mine from Sessions
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex gap-1">
                {([
                  { key: "all" as TypeFilter, label: `All (${counts.total})` },
                  { key: "session" as TypeFilter, label: `Sessions (${counts.session})` },
                  { key: "task" as TypeFilter, label: `Tasks (${counts.task})` },
                  { key: "doc" as TypeFilter, label: `Docs (${counts.doc})` },
                ]).map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setTypeFilter(f.key)}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      typeFilter === f.key ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-0.5 border-l border-sol-border/30 pl-3 ml-1">
                {([
                  { key: "all" as OutcomeFilter, label: "Any", color: "" },
                  { key: "shipped" as OutcomeFilter, label: "Shipped", color: "text-sol-green" },
                  { key: "progress" as OutcomeFilter, label: "Active", color: "text-sol-cyan" },
                  { key: "blocked" as OutcomeFilter, label: "Blocked", color: "text-sol-red" },
                ]).map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setOutcomeFilter(f.key)}
                    className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                      outcomeFilter === f.key
                        ? `bg-sol-bg-highlight ${f.color || "text-sol-text"}`
                        : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {people.length > 1 && (
                <div className="flex items-center gap-1">
                  <User className="w-3 h-3 text-sol-text-dim" />
                  <select
                    value={personFilter}
                    onChange={(e) => setPersonFilter(e.target.value)}
                    className="text-xs bg-transparent border-none text-sol-text-dim hover:text-sol-text focus:outline-none cursor-pointer"
                  >
                    <option value="all">All people</option>
                    {people.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              )}

              {projects.length > 1 && (
                <div className="flex items-center gap-1">
                  <FolderOpen className="w-3 h-3 text-sol-text-dim" />
                  <select
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    className="text-xs bg-transparent border-none text-sol-text-dim hover:text-sol-text focus:outline-none cursor-pointer"
                  >
                    <option value="all">All projects</option>
                    {projects.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              )}

              {themeFilter && (
                <div className="flex items-center gap-1.5">
                  <Tag className="w-3 h-3 text-sol-cyan" />
                  <span className="text-xs text-sol-cyan">{themeFilter}</span>
                  <button
                    onClick={() => setThemeFilter(null)}
                    className="text-xs px-1 py-0.5 text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 rounded transition-colors"
                  >
                    x
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!grouped ? (
              <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">Loading...</div>
            ) : grouped.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                <Inbox className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No activity found</p>
                <button
                  onClick={handleMine}
                  disabled={mining}
                  className="mt-3 text-sm text-sol-cyan hover:underline"
                >
                  Mine tasks from sessions
                </button>
              </div>
            ) : (
              <div className="px-6 py-4 space-y-6">
                {grouped.map((group) => (
                  <div key={group.label}>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
                        {group.label}
                      </span>
                      <span className="text-xs text-sol-text-dim">({group.items.length})</span>
                      <div className="flex-1 h-px bg-sol-border/20" />
                    </div>
                    <div className="space-y-1.5">
                      {group.items.map((item: any, i: number) => {
                        const key = `${item.type}-${item.data?._id || item.data?.short_id || i}`;
                        if (item.type === "session") {
                          const convId = item.data?.conversation_id;
                          return (
                            <SessionCard
                              key={key}
                              item={item}
                              childTasks={convId ? childTaskMap.get(convId) : undefined}
                              childDocs={convId ? childDocMap.get(convId) : undefined}
                              themeFilter={themeFilter}
                              onThemeClick={(t) => setThemeFilter(themeFilter === t ? null : t)}
                            />
                          );
                        }
                        if (item.type === "task") return <TaskCard key={key} item={item} themeFilter={themeFilter} onThemeClick={(t) => setThemeFilter(themeFilter === t ? null : t)} />;
                        if (item.type === "doc") return <DocCard key={key} item={item} themeFilter={themeFilter} onThemeClick={(t) => setThemeFilter(themeFilter === t ? null : t)} />;
                        return null;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
