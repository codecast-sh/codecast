import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Target,
  Zap,
} from "lucide-react";
import { taskVisual } from "./TaskStatusBadge";
import { stripMarkdown, docContentPreview, docBodyMarkdown } from "../lib/notificationText";
import { type EntityType } from "../lib/entityLinks";
import { AgentTypeIcon } from "./AgentTypeIcon";
import { cleanUserMessage } from "./sessionMessage";
import { cleanTitle } from "../lib/conversationProcessor";
import { getLabelColor } from "../lib/labelColors";
import { getProjectName } from "../store/inboxStore";
import { imageBytes } from "../lib/imageByteCache";
import { sessionCardSummary } from "../lib/sessionSummary";
import { FormattedSummary } from "./FormattedSummary";
import { MarkdownBlocks } from "./tools/MarkdownRenderer";
import { clipFade } from "./CollapsibleBody";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { describeTaskCadence, taskStateLabel } from "./triggerCadence";
import {
  AuthorAvatar,
  PRIORITY_CONFIG,
  STATUS_COLOR,
  STATUS_LABEL,
  SessionSummaryBlock,
  TYPE_LABEL,
  abbrevModel,
  relativeTime,
  taskPeople,
  useEntityResolution,
} from "./entityDisplay";

// The preview card a SHARED object renders as — the rich sibling of the inline
// pill. remarkEntityCards promotes a references-only paragraph (or list) into
// a card row; each card previews its object usably in place (title, state, a
// real snippet) and expands inline to full width for browsing without leaving
// the conversation. One card alone in its row stretches and shows more; cards
// sharing a row start compact and any of them expands to span the row.
//
// Rendering rides the same resolution as the pill (useEntityResolution): local
// store seed on the first frame, live webGet keeping it fresh. The expanded
// detail needs no extra queries — webGet already carries the deep fields
// (doc content, plan tasks, task comments).

// Every class literal in full — Tailwind's scanner never sees a composed
// string like `hover:${accent.text}`, so composition would silently produce
// no CSS at all. The strip tint is stronger in light mode (a 6% wash reads
// as nothing on white); `borderOpen`/`stripOpen` are the open-state raise, so
// an expanded card reads as open at a glance, not just by its chevron.
type Accent = {
  text: string;
  hoverText: string;
  border: string;
  borderOpen: string;
  borderHover: string;
  strip: string;
  stripOpen: string;
  stripBorder: string;
  ring: string;
  chevronHover: string;
  bar: string;
};
const ACCENT: Record<EntityType, Accent> = {
  session: { text: "text-sol-blue", hoverText: "hover:text-sol-blue", border: "border-sol-blue/25", borderOpen: "border-sol-blue/45", borderHover: "hover:border-sol-blue/45", strip: "bg-sol-blue/10 dark:bg-sol-blue/[0.06]", stripOpen: "bg-sol-blue/[0.15] dark:bg-sol-blue/10", stripBorder: "border-sol-blue/15", ring: "focus-visible:ring-sol-blue/35", chevronHover: "group-hover/card:text-sol-blue", bar: "bg-sol-blue" },
  task: { text: "text-sol-violet", hoverText: "hover:text-sol-violet", border: "border-sol-violet/25", borderOpen: "border-sol-violet/45", borderHover: "hover:border-sol-violet/45", strip: "bg-sol-violet/10 dark:bg-sol-violet/[0.06]", stripOpen: "bg-sol-violet/[0.15] dark:bg-sol-violet/10", stripBorder: "border-sol-violet/15", ring: "focus-visible:ring-sol-violet/35", chevronHover: "group-hover/card:text-sol-violet", bar: "bg-sol-violet" },
  plan: { text: "text-sol-cyan", hoverText: "hover:text-sol-cyan", border: "border-sol-cyan/25", borderOpen: "border-sol-cyan/45", borderHover: "hover:border-sol-cyan/45", strip: "bg-sol-cyan/10 dark:bg-sol-cyan/[0.06]", stripOpen: "bg-sol-cyan/[0.15] dark:bg-sol-cyan/10", stripBorder: "border-sol-cyan/15", ring: "focus-visible:ring-sol-cyan/35", chevronHover: "group-hover/card:text-sol-cyan", bar: "bg-sol-cyan" },
  doc: { text: "text-sol-green", hoverText: "hover:text-sol-green", border: "border-sol-green/25", borderOpen: "border-sol-green/45", borderHover: "hover:border-sol-green/45", strip: "bg-sol-green/10 dark:bg-sol-green/[0.06]", stripOpen: "bg-sol-green/[0.15] dark:bg-sol-green/10", stripBorder: "border-sol-green/15", ring: "focus-visible:ring-sol-green/35", chevronHover: "group-hover/card:text-sol-green", bar: "bg-sol-green" },
  trigger: { text: "text-sol-orange", hoverText: "hover:text-sol-orange", border: "border-sol-orange/25", borderOpen: "border-sol-orange/45", borderHover: "hover:border-sol-orange/45", strip: "bg-sol-orange/10 dark:bg-sol-orange/[0.06]", stripOpen: "bg-sol-orange/[0.15] dark:bg-sol-orange/10", stripBorder: "border-sol-orange/15", ring: "focus-visible:ring-sol-orange/35", chevronHover: "group-hover/card:text-sol-orange", bar: "bg-sol-orange" },
  project: { text: "text-sol-text-muted", hoverText: "hover:text-sol-text-muted", border: "border-sol-border", borderOpen: "border-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)]", borderHover: "hover:border-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)]", strip: "bg-sol-bg-alt", stripOpen: "bg-sol-bg-alt", stripBorder: "border-sol-border", ring: "focus-visible:ring-[color-mix(in_srgb,var(--sol-text-dim)_35%,transparent)]", chevronHover: "group-hover/card:text-sol-text-muted", bar: "bg-sol-text-dim" },
};

const TYPE_ICON: Record<EntityType, any> = {
  session: MessageSquare,
  task: Target, // replaced by the status disc at render time
  plan: Target,
  doc: FileText,
  trigger: Zap,
  project: Folder,
};

function MetaDot() {
  return <span className="text-[color-mix(in_srgb,var(--sol-text-dim)_60%,transparent)]">·</span>;
}

/**
 * The one-line, type-specific state row under the title. Each item is bundled
 * with its leading separator dot in one non-breaking span, so the line wraps
 * BETWEEN items and a dot can never dangle at a line end; fixed chips
 * (status, priority) never shrink, and only the wide chips (plan link,
 * author) truncate.
 */
function CardMetaLine({ type, entity }: { type: EntityType; entity: any }) {
  const parts: { key: string; node: React.ReactNode; shrink?: boolean }[] = [];
  const push = (node: React.ReactNode, key: string, shrink = false) => {
    parts.push({ key, node, shrink });
  };

  if (type === "task") {
    const v = taskVisual(entity.status);
    push(<span className={`whitespace-nowrap font-medium ${v.color}`}>{v.label}</span>, "status");
    const priority = PRIORITY_CONFIG[entity.priority];
    if (priority) {
      push(
        <span className={`inline-flex items-center gap-0.5 whitespace-nowrap ${priority.color}`}>
          <priority.icon className="h-2.5 w-2.5" />
          {priority.label}
        </span>,
        "priority",
      );
    }
    if (entity.plan?.title) {
      push(
        <span className="inline-flex min-w-0 items-center gap-1 text-sol-cyan">
          <Target className="h-2.5 w-2.5 flex-shrink-0" />
          <span className="truncate">{entity.plan.title}</span>
        </span>,
        "plan",
        true,
      );
    }
  } else if (type === "plan") {
    const color = STATUS_COLOR[entity.status || "active"] || "text-gray-400";
    push(<span className={`whitespace-nowrap font-medium ${color}`}>{STATUS_LABEL[entity.status] || entity.status || "Plan"}</span>, "status");
  } else if (type === "session") {
    const isActive = entity.status === "active";
    push(
      <span className={`whitespace-nowrap font-medium ${isActive ? "text-sol-green" : "text-sol-text-dim"}`}>
        {isActive ? "Active" : entity.status || "Stopped"}
      </span>,
      "status",
    );
    if (entity.agent_type) push(<span className="whitespace-nowrap">{entity.agent_type}</span>, "agent");
    const model = abbrevModel(entity.model);
    if (model) push(<span className="whitespace-nowrap">{model}</span>, "model");
    if (entity.author_name) push(<span className="truncate text-sol-text-muted">{entity.author_name}</span>, "author", true);
  } else if (type === "doc") {
    const typeLabel = entity.doc_type ? entity.doc_type.charAt(0).toUpperCase() + entity.doc_type.slice(1) : "Doc";
    push(<span className="font-medium text-sol-green">{typeLabel}</span>, "type");
  } else if (type === "trigger") {
    const failing = entity.last_run_failed || entity.last_run_needs_attention;
    const color = entity.status === "paused" ? "text-sol-yellow" : failing ? "text-sol-red" : "text-sol-orange";
    push(<span className={`whitespace-nowrap font-medium ${color}`}>{describeTaskCadence(entity)}</span>, "cadence");
    push(<span className="whitespace-nowrap">{taskStateLabel(entity, Date.now())}</span>, "state");
  } else {
    push(<span className="font-medium text-sol-text-dim">{TYPE_LABEL[type]}</span>, "type");
  }

  if (parts.length === 0) return null;
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-sol-text-muted">
      {parts.map((p, i) => (
        <span key={p.key} className={`inline-flex items-center gap-1.5 ${p.shrink ? "min-w-0" : "flex-shrink-0"}`}>
          {i > 0 && <MetaDot />}
          {p.node}
        </span>
      ))}
    </div>
  );
}

function planProgress(plan: any): { done: number; total: number; pct: number } | null {
  // plans.webGet embeds tasks[]; the store seed carries a progress summary.
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : null;
  const done = tasks ? tasks.filter((t: any) => t.status === "done").length : plan.progress?.done;
  const total = tasks ? tasks.length : plan.progress?.total;
  if (typeof done !== "number" || typeof total !== "number" || total === 0) return null;
  return { done, total, pct: Math.round((done / total) * 100) };
}

function ProgressBar({ done, total, pct, bar }: { done: number; total: number; pct: number; bar: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--sol-border)_45%,transparent)]">
        <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-sol-text-dim">{done}/{total}</span>
    </div>
  );
}

/**
 * A session shared in chat reads exactly like its inbox card — the "simple"
 * card people already know: agent icon + title, the summary, the blue `>` last
 * user line, then author / project / count / age on one footer line, with the
 * image thumbnail on the right. Built from the SAME atoms the inbox card uses
 * (AgentTypeIcon, cleanTitle, cleanUserMessage, sessionCardSummary,
 * getLabelColor, imageBytes) so the two can't drift apart visually.
 */
function SessionCardBody({ session, expanded }: { session: any; expanded: boolean }) {
  const thumbSrc = imageBytes.useSrc(session.image_preview_url || undefined);
  const title = cleanTitle(session.title || "New Session");
  const summary = sessionCardSummary(session);
  const userLine = cleanUserMessage(session.last_message_preview);
  const project = getProjectName(undefined, session.project_path);
  const projectColor = project ? getLabelColor(project) : null;
  const isLive = !!session.is_active;

  return (
    <div className="flex items-start gap-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] leading-tight text-sol-text">
          <span className="flex-shrink-0" title={session.agent_type || "claude_code"}>
            <AgentTypeIcon agentType={session.agent_type || "claude_code"} className="w-3.5 h-3.5" />
          </span>
          <span className={`min-w-0 font-medium ${expanded ? "" : "truncate"}`}>{title}</span>
          {isLive && (
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0" title="Live">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sol-green" />
            </span>
          )}
        </div>
        {summary && (
          <div className={`mt-0.5 text-[11px] leading-snug text-sol-text-muted ${expanded ? "whitespace-pre-line" : "line-clamp-2"}`}>
            <FormattedSummary text={summary} />
          </div>
        )}
        {userLine && (
          <div className={`mt-0.5 text-[11px] font-semibold leading-snug text-sky-700 dark:text-sky-300 ${expanded ? "" : "truncate"}`}>
            <span className="mr-0.5 text-sky-600/60 dark:text-sky-400/50">&gt;</span>
            {userLine}
          </div>
        )}
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-sol-text-dim">
          {(session.author_name || session.author_avatar) && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <AuthorAvatar name={session.author_name} avatar={session.author_avatar} size={12} />
              <span className="max-w-[120px] truncate text-sol-text-muted">{session.author_name}</span>
            </span>
          )}
          {project && projectColor && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${projectColor.dot}`} />
              <span className={`max-w-[140px] truncate ${projectColor.text ?? "text-sol-text-muted"}`}>{project}</span>
            </span>
          )}
          <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            {session.message_count > 0 && <span className="tabular-nums">{session.message_count}</span>}
            {relativeTime(session.updated_at) && <span>{relativeTime(session.updated_at)}</span>}
          </span>
        </div>
      </div>
      {thumbSrc && (
        <img
          src={thumbSrc}
          alt=""
          className={`flex-shrink-0 rounded border border-sol-border object-cover ${expanded ? "max-h-40 max-w-[220px]" : "h-[46px] w-[46px]"}`}
        />
      )}
    </div>
  );
}

/** The usable snippet a collapsed card shows — the reason to expand, visible before it. */
function CardSnippet({ type, entity, compact }: { type: EntityType; entity: any; compact: boolean }) {
  const clamp = compact ? "line-clamp-2" : "line-clamp-3";

  if (type === "task") {
    const last = Array.isArray(entity.comments) && entity.comments.length > 0
      ? [...entity.comments].sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0)).at(-1)
      : null;
    if (!entity.description && !last) return null;
    return (
      <div className="space-y-1">
        {entity.description && (
          <p className={`text-[11px] leading-relaxed text-sol-text-muted ${clamp}`}>
            {stripMarkdown(entity.description).slice(0, 400)}
          </p>
        )}
        {last?.text && (
          <div className="flex items-baseline gap-1 border-l-2 border-[color-mix(in_srgb,var(--sol-border)_70%,transparent)] pl-1.5 text-[10px] leading-snug">
            {last.author && <span className="flex-shrink-0 font-medium text-sol-text-muted">{last.author}</span>}
            <span className="min-w-0 truncate text-sol-text-dim">{stripMarkdown(last.text)}</span>
            {last.created_at && <span className="ml-auto flex-shrink-0 text-sol-text-dim/70">{relativeTime(last.created_at)}</span>}
          </div>
        )}
      </div>
    );
  }
  if (type === "plan") {
    const progress = planProgress(entity);
    return (
      <div className="space-y-1.5">
        {entity.goal && (
          <p className={`text-[11px] leading-relaxed text-sol-text-muted ${clamp}`}>
            {stripMarkdown(entity.goal).slice(0, 400)}
          </p>
        )}
        {progress && <ProgressBar {...progress} bar={ACCENT.plan.bar} />}
      </div>
    );
  }
  if (type === "session") {
    return <SessionSummaryBlock session={entity} />;
  }
  if (type === "doc") {
    const preview = docContentPreview(entity.content, compact ? 260 : 700);
    if (!preview) return null;
    return (
      <div className="overflow-hidden" style={{ maxHeight: compact ? 54 : 108, ...clipFade(28) }}>
        <p className="whitespace-pre-line text-[11px] leading-relaxed text-sol-text-muted">{preview}</p>
      </div>
    );
  }
  if (type === "trigger") {
    const text = entity.display_summary || entity.prompt;
    if (!text) return null;
    return (
      <p className={`text-[11px] leading-relaxed text-sol-text-muted ${clamp}`}>
        {stripMarkdown(text).slice(0, 400)}
      </p>
    );
  }
  const summary = entity.description || entity.goal || entity.summary;
  if (!summary) return null;
  return <p className={`text-[11px] leading-relaxed text-sol-text-muted ${clamp}`}>{stripMarkdown(summary).slice(0, 400)}</p>;
}

// Markdown rendered inside a card: the same shared blocks as doc transclusion,
// with the same list-outside override (see DocEmbed for why).
function CardMarkdown({ content }: { content: string }) {
  return (
    <div className="text-[12px] [&_ol]:!list-outside [&_ol]:!pl-5 [&_ul]:!list-outside [&_ul]:!pl-5">
      <MarkdownBlocks content={content} />
    </div>
  );
}

function PersonChip({ label, person }: { label: string; person: { name?: string; image?: string | null } }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] text-sol-text-dim">{label}</span>
      <AuthorAvatar name={person.name} avatar={person.image} size={12} />
      <span className="max-w-[140px] truncate text-[10px] text-sol-text-muted">{person.name}</span>
    </span>
  );
}

function CommentRows({ comments }: { comments: any[] }) {
  const recent = [...comments]
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))
    .slice(-3);
  if (recent.length === 0) return null;
  return (
    <div className="space-y-1.5 border-t border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] pt-2">
      {comments.length > recent.length && (
        <div className="text-[10px] text-sol-text-dim">{comments.length - recent.length} earlier comments</div>
      )}
      {recent.map((c: any, i: number) => (
        <div key={c._id ?? i} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
          <span className="max-w-[180px] flex-shrink-0 truncate font-medium text-sol-text-muted">{c.session_info?.title || c.author}:</span>
          <span className="line-clamp-3 min-w-0 whitespace-pre-line text-sol-text-muted [overflow-wrap:anywhere]">{c.text}</span>
          {c.created_at && <span className="ml-auto flex-shrink-0 text-[10px] text-sol-text-dim">{relativeTime(c.created_at)}</span>}
        </div>
      ))}
    </div>
  );
}

function PlanTaskRows({ tasks }: { tasks: any[] }) {
  if (!tasks || tasks.length === 0) return null;
  return (
    <div className="max-h-64 space-y-0.5 overflow-y-auto">
      {tasks.map((t: any) => {
        const v = taskVisual(t.status);
        return (
          <div key={t._id} className="flex items-center gap-1.5 py-0.5 text-[11px]">
            <v.icon className={`h-3 w-3 flex-shrink-0 ${v.color}`} />
            <span className={`min-w-0 truncate ${t.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
              {t.title}
            </span>
            {t.assignee_info?.name && (
              <span className="ml-auto flex-shrink-0 text-[10px] text-sol-text-dim">{t.assignee_info.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The full inline browse — what expanding a card reveals. */
function CardDetail({ type, entity }: { type: EntityType; entity: any }) {
  if (type === "task") {
    const { creator, assignee } = taskPeople(entity);
    return (
      <div className="space-y-2.5">
        {entity.description ? (
          <CardMarkdown content={entity.description} />
        ) : (
          <p className="text-[11px] italic text-sol-text-dim">No description.</p>
        )}
        {(creator || assignee || (entity.labels?.length ?? 0) > 0) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {creator && <PersonChip label="Creator" person={creator} />}
            {assignee && <PersonChip label="Assignee" person={assignee} />}
            {(entity.labels ?? []).map((l: string) => (
              <span key={l} className="rounded bg-sol-magenta/10 px-1.5 text-[10px] leading-[1.6] text-sol-magenta">
                {l}
              </span>
            ))}
          </div>
        )}
        {entity.comments?.length > 0 && <CommentRows comments={entity.comments} />}
      </div>
    );
  }
  if (type === "plan") {
    const progress = planProgress(entity);
    return (
      <div className="space-y-2.5">
        {entity.goal && <CardMarkdown content={entity.goal} />}
        {progress && <ProgressBar {...progress} bar={ACCENT.plan.bar} />}
        {Array.isArray(entity.tasks) && <PlanTaskRows tasks={entity.tasks} />}
      </div>
    );
  }
  if (type === "session") {
    const projectName = entity.project_path?.split("/").pop() ?? null;
    return (
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-sol-text-dim">
          {entity.message_count != null && <span className="font-mono">{entity.message_count} msgs</span>}
          {projectName && (
            <span className="inline-flex items-center gap-1 font-mono">
              <FolderOpen className="h-2.5 w-2.5" />
              {projectName}
            </span>
          )}
          {entity.git_branch && (
            <span className="inline-flex items-center gap-1 font-mono">
              <GitBranch className="h-2.5 w-2.5" />
              {entity.git_branch}
            </span>
          )}
          {entity.started_at && <span>started {relativeTime(entity.started_at)}</span>}
        </div>
      </div>
    );
  }
  if (type === "doc") {
    return (
      <div className="max-h-[70vh] overflow-y-auto pr-1">
        <CardMarkdown content={docBodyMarkdown(entity.content)} />
      </div>
    );
  }
  if (type === "trigger") {
    const failing = entity.last_run_failed || entity.last_run_needs_attention;
    return (
      <div className="space-y-2.5">
        {entity.prompt && (
          <div className="max-h-72 overflow-y-auto">
            <CardMarkdown content={entity.prompt} />
          </div>
        )}
        {(entity.last_run_at || entity.run_count > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-sol-text-dim">
            {entity.last_run_at && (
              <span className={failing ? "text-sol-red" : ""}>
                {failing ? "Last run failed" : "Last run"} {relativeTime(entity.last_run_at)}
              </span>
            )}
            {entity.run_count > 0 && <span className="font-mono">{entity.run_count} runs</span>}
          </div>
        )}
      </div>
    );
  }
  const summary = entity.description || entity.goal || entity.summary;
  return summary ? <CardMarkdown content={summary} /> : <p className="text-[11px] italic text-sol-text-dim">Nothing more here.</p>;
}

/**
 * One shared object, rendered as a browsable card. `count` is how many cards
 * share the row (from the remark plugin): alone it renders rich; in a group it
 * starts compact and expanding makes it span the whole row.
 */
export function EntityObjectCard({ refId, count }: { refId: string; count: number }) {
  const { rawId, type, entity, served, label, href } = useEntityResolution(refId);
  const [expanded, setExpanded] = useState(false);
  // The detail stays mounted through the CLOSE animation — unmounting with the
  // toggle would snap the card shut with nothing inside to shrink. Cleared on
  // transitionend, with a timer fallback for reduced-motion (no transition, so
  // no transitionend ever fires).
  const [mounted, setMounted] = useState(false);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openLinkedSession = useOpenLinkedSession();

  const setOpen = useCallback((open: boolean) => {
    if (unmountTimer.current) {
      clearTimeout(unmountTimer.current);
      unmountTimer.current = null;
    }
    setExpanded(open);
    if (open) setMounted(true);
    else unmountTimer.current = setTimeout(() => setMounted(false), 320);
  }, []);
  useEffect(
    () => () => {
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    // A click that ends a text selection is copying, not toggling.
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && !sel.isCollapsed) return;
    setOpen(!expanded);
  }, [expanded, setOpen]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(!expanded);
      }
    },
    [expanded, setOpen],
  );

  const openObject = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (type !== "session" || !entity?._id) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openLinkedSession(entity);
    },
    [type, entity, openLinkedSession],
  );

  // Same degrade rule as the pill: an id that resolves to no entity table (or
  // is still resolving) renders back as the text that was typed.
  if (!type) return <span className="font-mono text-[11px] text-sol-text-dim">{refId}</span>;

  const accent = ACCENT[type];
  const compact = count > 1 && !expanded;
  const isSession = type === "session";
  const isActive = isSession && entity?.status === "active";
  const Icon = TYPE_ICON[type];
  const taskV = type === "task" ? taskVisual(entity?.status) : null;
  const timeAgo = relativeTime(entity?.updated_at);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      // Explicit name: without it a screen reader would concatenate the whole
      // card's text, including the nested "Open …" links, into the button name.
      aria-label={`${TYPE_LABEL[type]}: ${entity ? label : rawId}`}
      onClick={toggle}
      onKeyDown={onKeyDown}
      style={expanded && count > 1 ? { gridColumn: "1 / -1" } : undefined}
      className={`entity-card group/card relative min-w-0 cursor-pointer overflow-hidden border ${expanded ? `rounded-lg ${accent.borderOpen} bg-sol-bg shadow-xl` : `rounded-md ${accent.border} bg-sol-card`} ${accent.borderHover} text-left transition-colors focus-visible:outline-none focus-visible:ring-1 ${accent.ring}`}
    >
      {/* A session renders as its inbox card — flat, no header strip; the
          open/expand controls float over the top-right corner on hover. */}
      {isSession && entity && (
        <>
          <div className="absolute right-1.5 top-1.5 z-[1] flex items-center gap-0.5 rounded bg-sol-card/80 opacity-0 backdrop-blur-sm transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
            <Link
              href={href}
              onClick={openObject}
              title="Open session"
              className={`rounded p-0.5 text-sol-text-dim ${accent.hoverText}`}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
            <ChevronDown
              className={`h-3 w-3 text-sol-text-dim transition-transform duration-200 ${accent.chevronHover} ${expanded ? "rotate-180" : ""}`}
            />
          </div>
          <div className={expanded ? "px-3.5 pb-1 pt-2.5" : "px-3 py-2"}>
            <SessionCardBody session={entity} expanded={expanded} />
          </div>
        </>
      )}

      {/* Header strip: identity + state, always visible. */}
      {!(isSession && entity) && (
      <div className={`flex items-start gap-2 border-b ${accent.stripBorder} ${expanded ? accent.stripOpen : accent.strip} px-2.5 py-1.5 transition-colors`}>
        <span className="relative mt-[2px] flex-shrink-0">
          {isSession && (entity?.author_name || entity?.author_avatar) ? (
            <AuthorAvatar name={entity.author_name} avatar={entity.author_avatar} size={16} />
          ) : taskV ? (
            <taskV.icon className={`h-3.5 w-3.5 ${taskV.color}`} />
          ) : (
            <Icon className={`h-3.5 w-3.5 ${accent.text}`} />
          )}
          {(isActive || (type === "trigger" && entity?.status === "running")) && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-sol-bg bg-sol-green" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-medium leading-snug text-sol-text ${expanded ? "" : "truncate"}`}>
            {/* `label` is clipped to pill length (~40 chars) — right for a
                collapsed row, wrong at full width, where the real title fits. */}
            {entity ? (
              expanded ? (type === "trigger" ? entity.display_title : undefined) || entity.title || entity.display_title || entity.name || label : label
            ) : (
              <span className="font-mono text-sol-text-dim">{rawId}</span>
            )}
          </div>
          {entity && !compact && <CardMetaLine type={type} entity={entity} />}
        </div>
        <div className="mt-[1px] flex flex-shrink-0 items-center gap-1.5">
          {timeAgo && !compact && <span className="text-[10px] text-sol-text-dim">{timeAgo}</span>}
          <Link
            href={href}
            onClick={openObject}
            title={`Open ${TYPE_LABEL[type].toLowerCase()}`}
            className={`rounded p-0.5 text-sol-text-dim opacity-0 transition-opacity ${accent.hoverText} focus-visible:opacity-100 group-hover/card:opacity-100`}
          >
            <ArrowUpRight className="h-3 w-3" />
          </Link>
          <ChevronDown
            className={`h-3 w-3 text-sol-text-dim transition-transform duration-200 ${accent.chevronHover} ${expanded ? "rotate-180" : ""}`}
          />
        </div>
      </div>
      )}

      {/* Preview body — the usable snippet, before any click. */}
      {entity && !expanded && !isSession && (
        <div className={compact ? "px-2.5 py-1.5" : "px-2.5 py-2"}>
          {compact && <CardMetaLine type={type} entity={entity} />}
          <div className={compact ? "mt-1" : ""}>
            <CardSnippet type={type} entity={entity} compact={compact} />
          </div>
        </div>
      )}
      {!entity &&
        (served ? (
          <div className="px-2.5 py-2 text-[11px] text-sol-text-dim">Not available to you.</div>
        ) : (
          <div className="space-y-1.5 px-2.5 py-2.5" aria-hidden>
            <div className="h-2 w-3/4 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
            <div className="h-2 w-1/2 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
          </div>
        ))}

      {/* The inline browse: animated open AND close, scrollable inside. */}
      <div
        className="entity-card-expand"
        data-open={expanded || undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && !expanded) setMounted(false);
        }}
      >
        <div>
          {entity && mounted && (
            <div className={`cursor-auto ${expanded || mounted ? "px-3.5 pb-3 pt-2" : "px-2.5 pb-2.5 pt-2"}`} onClick={(e) => e.stopPropagation()}>
              <CardDetail type={type} entity={entity} />
              <div className="mt-2.5 flex items-center justify-between border-t border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] pt-1.5">
                <span className="font-mono text-[10px] text-sol-text-dim">{entity.short_id ?? rawId}</span>
                <Link
                  href={href}
                  onClick={openObject}
                  className={`inline-flex items-center gap-0.5 text-[10px] ${accent.text} no-underline hover:underline`}
                >
                  Open {TYPE_LABEL[type].toLowerCase()}
                  <ArrowUpRight className="h-2.5 w-2.5" />
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
