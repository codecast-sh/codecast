import React, { useState, useCallback } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSlideOutStore } from "../store/slideOutStore";
import { useInboxStore } from "../store/inboxStore";
import { useRouter } from "next/navigation";
import {
  Target,
  Circle,
  CircleDot,
  CheckCircle2,
  CircleDotDashed,
  XCircle,
  ArrowUpRight,
  AlertTriangle,
  ArrowUp,
  Minus,
  ArrowDown,
  MessageSquare,
  Folder,
  Cpu,
  User,
} from "lucide-react";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";

const api = _api as any;

const ENTITY_ID_RE = /^(ct|pl)-[a-z0-9]+$/i;
const SESSION_ID_RE = /^jx[a-z0-9]{5}$/i;

const STATUS_ICON: Record<string, any> = {
  draft: CircleDotDashed,
  open: Circle,
  in_progress: CircleDot,
  in_review: CircleDot,
  done: CheckCircle2,
  dropped: XCircle,
  backlog: Circle,
};

const STATUS_COLOR: Record<string, string> = {
  draft: "text-gray-400",
  open: "text-sol-blue",
  backlog: "text-gray-400",
  in_progress: "text-sol-yellow",
  in_review: "text-sol-violet",
  done: "text-sol-green",
  dropped: "text-gray-500",
  active: "text-sol-green",
  paused: "text-sol-yellow",
  abandoned: "text-gray-500",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  dropped: "Dropped",
  active: "Active",
  paused: "Paused",
  abandoned: "Abandoned",
};

const PRIORITY_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  urgent: { icon: AlertTriangle, color: "text-red-400", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-orange-400", label: "High" },
  medium: { icon: Minus, color: "text-sol-yellow", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-blue", label: "Low" },
};

export function isEntityId(text: string): boolean {
  const t = text.trim();
  return ENTITY_ID_RE.test(t) || SESSION_ID_RE.test(t);
}

function isSessionId(text: string): boolean {
  return SESSION_ID_RE.test(text.trim());
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\n+/g, " ")
    .trim();
}

function TaskHoverContent({ task }: { task: any }) {
  const StatusIcon = STATUS_ICON[task.status || "open"] || Circle;
  const statusColor = STATUS_COLOR[task.status || "open"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[task.status] || task.status;
  const priority = PRIORITY_CONFIG[task.priority];

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {task.title || task.short_id}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
            {priority && (
              <>
                <span className="text-gray-600">·</span>
                <span className={`inline-flex items-center gap-0.5 text-[10px] ${priority.color}`}>
                  <priority.icon className="w-2.5 h-2.5" />
                  {priority.label}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {task.description && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(task.description).slice(0, 200)}
        </p>
      )}

      {task.plan && (
        <div className="flex items-center gap-1.5 pl-[22px]">
          <Target className="w-2.5 h-2.5 text-sol-cyan flex-shrink-0" />
          <span className="text-[10px] text-sol-cyan truncate">{task.plan.title}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{task.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

function PlanHoverContent({ plan }: { plan: any }) {
  const statusColor = STATUS_COLOR[plan.status || "active"] || "text-gray-400";
  const statusLabel = STATUS_LABEL[plan.status] || plan.status;

  const tasks = plan.tasks || [];
  const doneCount = tasks.filter((t: any) => t.status === "done").length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Target className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${statusColor}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {plan.title || plan.short_id}
          </div>
          <span className={`text-[10px] font-medium ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      {plan.goal && (
        <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(plan.goal).slice(0, 200)}
        </p>
      )}

      {total > 0 && (
        <div className="flex items-center gap-2 pl-[22px]">
          <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className="h-full rounded-full bg-sol-green transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-gray-500 font-mono">
            {doneCount}/{total}
          </span>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-0.5 pl-[22px] max-h-[120px] overflow-y-auto">
          {tasks.slice(0, 6).map((t: any) => {
            const Icon = STATUS_ICON[t.status] || Circle;
            const color = STATUS_COLOR[t.status] || "text-gray-400";
            return (
              <div key={t._id} className="flex items-center gap-1.5 py-0.5 text-[10px]">
                <Icon className={`w-2.5 h-2.5 flex-shrink-0 ${color}`} />
                <span className={`truncate ${t.status === "done" ? "line-through text-gray-500" : "text-gray-400"}`}>
                  {t.title}
                </span>
              </div>
            );
          })}
          {tasks.length > 6 && (
            <div className="text-[10px] text-gray-500 pt-0.5">+{tasks.length - 6} more</div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{plan.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  cowork: "Cowork",
};

function SessionHoverContent({ session }: { session: any }) {
  const isActive = session.status === "active";
  const projectName = session.project_path?.split("/").pop();
  const agentLabel = AGENT_LABELS[session.agent_type] || session.agent_type;
  const timeAgo = session.updated_at
    ? formatTimeAgo(session.updated_at)
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <MessageSquare className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${isActive ? "text-sol-green" : "text-gray-400"}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">
            {session.title || "New Session"}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-medium ${isActive ? "text-sol-green" : "text-gray-400"}`}>
              {isActive ? "Active" : "Completed"}
            </span>
            <span className="text-gray-600">·</span>
            <span className="text-[10px] text-gray-400 inline-flex items-center gap-0.5">
              <Cpu className="w-2.5 h-2.5" />
              {agentLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-1 pl-[22px]">
        {projectName && (
          <div className="flex items-center gap-1.5">
            <Folder className="w-2.5 h-2.5 text-gray-500 flex-shrink-0" />
            <span className="text-[10px] text-gray-400 truncate">{projectName}</span>
          </div>
        )}
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span>{session.message_count} msgs</span>
          {session.model && <span>{session.model}</span>}
          {timeAgo && <span>{timeAgo}</span>}
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500 font-mono">{session.short_id}</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          Click to open <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

function UserHoverContent({ user }: { user: any }) {
  const name = user.name || user.github_username || "Unknown";
  const handle = user.github_username ? `@${user.github_username}` : null;

  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {user.image || user.github_avatar_url ? (
          <img
            src={user.image || user.github_avatar_url}
            alt=""
            className="w-8 h-8 rounded-full object-cover flex-shrink-0"
          />
        ) : (
          <span className="w-8 h-8 rounded-full bg-sol-green/20 flex items-center justify-center flex-shrink-0">
            <User className="w-4 h-4 text-sol-green" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{name}</div>
          {handle && (
            <span className="text-[10px] text-gray-400 font-mono">{handle}</span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between pt-1 border-t border-white/5">
        <span className="text-[10px] text-gray-500">Team member</span>
        <span className="text-[10px] text-gray-500 inline-flex items-center gap-0.5">
          View profile <ArrowUpRight className="w-2.5 h-2.5" />
        </span>
      </div>
    </div>
  );
}

export function UserMentionPill({ handle }: { handle: string }) {
  const router = useRouter();
  const user = useQuery(api.users.getUserByUsername, { username: handle });
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = { current: null as ReturnType<typeof setTimeout> | null };

  const handleMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 250);
  }, []);
  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 150);
  }, []);
  const profilePath = user?.github_username
    ? `/team/${user.github_username}` : `/team/${handle}`;
  const handleClick = useCallback(() => {
    setHoverOpen(false);
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    router.push(profilePath);
  }, [router, profilePath]);

  const label = user?.name || `@${handle}`;
  const avatar = user?.image || user?.github_avatar_url;

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <button
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="inline-flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-medium leading-[1.4] bg-sol-green/10 text-sol-green border border-sol-green/20 hover:bg-sol-green/20 transition-colors cursor-pointer align-baseline"
        >
          {avatar ? (
            <img src={avatar} alt="" className="w-3 h-3 rounded-full object-cover" />
          ) : (
            <User className="w-2.5 h-2.5 flex-shrink-0" />
          )}
          <span>{label}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        className="w-56 bg-sol-bg border border-sol-border shadow-xl p-3 cursor-pointer"
        side="top"
        align="start"
        sideOffset={6}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {user ? (
          <UserHoverContent user={user} />
        ) : (
          <div className="text-[11px] text-gray-500">@{handle}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|@[\w.-]+))?\](?:\s*\([^)]*\))?/g;

function MentionPill({ name, entityId }: { name: string; entityId?: string }) {
  if (entityId && isEntityId(entityId)) {
    return <EntityIdPill shortId={entityId} />;
  }
  if (entityId && /^@[\w.-]+$/.test(entityId)) {
    return <UserMentionPill handle={entityId.slice(1)} />;
  }
  return <UserMentionPill handle={name} />;
}

export function renderWithMentions(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const name = match[1].trim();
    const entityId = match[2];
    parts.push(<MentionPill key={match.index} name={name} entityId={entityId} />);
    lastIndex = MENTION_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

export function EntityAwareCode({ children, className, ...props }: any) {
  const text = String(children);
  if (!className && isEntityId(text)) {
    return <EntityIdPill shortId={text} />;
  }
  return <code className={className} {...props}>{children}</code>;
}

export function EntityAwareLink({ href, children, ...props }: any) {
  if (href?.startsWith("entity://")) {
    return <EntityIdPill shortId={href.slice(9)} />;
  }
  if (href?.startsWith("user://")) {
    const handle = decodeURIComponent(href.slice(7));
    return <UserMentionPill handle={handle} />;
  }
  if (href?.startsWith("mention://")) {
    const name = decodeURIComponent(href.slice(10));
    return <UserMentionPill handle={name} />;
  }
  const text = typeof children === "string" ? children : Array.isArray(children) ? children.map(String).join("") : String(children ?? "");
  if (isEntityId(text)) {
    return <EntityIdPill shortId={text} />;
  }
  return <a href={href} {...props}>{children}</a>;
}

export function EntityIdPill({ shortId }: { shortId: string }) {
  const id = shortId.toLowerCase().trim();
  const prefix = id.split("-")[0];
  const isTask = prefix === "ct";
  const isPlan = prefix === "pl";
  const isSession = isSessionId(id);
  const openSlideOut = useSlideOutStore((s) => s.open);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);

  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverTimeout = { current: null as ReturnType<typeof setTimeout> | null };

  const task = useQuery(api.tasks.webGet, isTask ? { short_id: id } : "skip");
  const plan = useQuery(api.plans.webGet, isPlan ? { short_id: id } : "skip");
  const session = useQuery(api.conversations.webGet, isSession ? { short_id: id } : "skip");

  const entity = isTask ? task : isPlan ? plan : session;
  const status = entity?.status;

  const Icon = isSession
    ? MessageSquare
    : isPlan
      ? Target
      : STATUS_ICON[status || "open"] || Circle;

  const colors = isSession
    ? "bg-sol-violet/10 text-sol-violet border-sol-violet/20 hover:bg-sol-violet/20"
    : isPlan
      ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20"
      : "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/20 hover:bg-sol-yellow/20";

  const handleMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverOpen(true), 250);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    hoverTimeout.current = setTimeout(() => setHoverOpen(false), 150);
  }, []);

  const handleClick = useCallback(() => {
    setHoverOpen(false);
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    if (!entity?._id) return;
    if (isSession) {
      navigateToSession(entity._id);
    } else {
      openSlideOut(isTask ? "task" : "plan", entity._id);
    }
  }, [openSlideOut, entity, isTask, isSession, navigateToSession]);

  const label = isSession && session?.title
    ? truncate(session.title, 24)
    : id;

  return (
    <Popover open={hoverOpen} onOpenChange={setHoverOpen}>
      <PopoverAnchor asChild>
        <button
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className={`inline-flex items-center gap-1 px-1.5 py-0 rounded text-[11px] font-mono leading-[1.4] ${colors} border transition-colors cursor-pointer align-baseline`}
        >
          <Icon className="w-2.5 h-2.5 flex-shrink-0" />
          <span>{label}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        className="w-64 bg-sol-bg border border-sol-border shadow-xl p-3 cursor-pointer"
        side="top"
        align="start"
        sideOffset={6}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {entity ? (
          isSession ? <SessionHoverContent session={entity} />
          : isTask ? <TaskHoverContent task={entity} />
          : <PlanHoverContent plan={entity} />
        ) : (
          <div className="text-[11px] text-gray-500">{id}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
