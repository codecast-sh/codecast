import { Bot, CheckSquare, FileText, FolderOpen, Hash, Lock, MessageSquare, Shield, Slash, Tag, Target, User, Calendar } from "lucide-react";
import type { MentionItem } from "./MentionList";
import { useInboxStore, placeInboxRows, rankVerdictOf } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { AvatarImg } from "../../lib/avatarCache";
import { SlackLogo } from "../SlackLogo";
import { visitTimeAgo } from "../../lib/recentVisits";
import { statusesForTeam, taskStatusOf } from "../../lib/taskStatuses";
import { agentDisplayName, deriveLiveAt, modelDisplayLabel } from "@codecast/shared/contracts";
import { liveFactsOf } from "../../lib/liveness";
import { SessionFace } from "../identity";
import { identityLine, identityRowOf, sessionIdentity } from "../../lib/sessionIdentity";
import { usePersonifyAll } from "../../hooks/usePersonifyAll";

const TYPES = {
  session: { icon: MessageSquare, label: "Session", color: "text-sol-blue" },
  task: { icon: CheckSquare, label: "Task", color: "text-sol-violet" },
  doc: { icon: FileText, label: "Doc", color: "text-sol-cyan" },
  plan: { icon: Target, label: "Plan", color: "text-sol-violet" },
  label: { icon: Tag, label: "Label", color: "text-sol-magenta" },
  person: { icon: User, label: "Person", color: "text-sol-green" },
  // An org role (the org page's violet shield): @handle wakes its agent.
  role: { icon: Shield, label: "Role", color: "text-sol-violet" },
  file: { icon: FolderOpen, label: "File", color: "text-sol-text-dim" },
  skill: { icon: Slash, label: "Command", color: "text-sol-orange" },
  channel: { icon: Hash, label: "Channel", color: "text-sol-cyan" },
  date: { icon: Calendar, label: "Date", color: "text-sol-orange" },
};

const STATE_DOTS: Record<string, string> = {
  working: "bg-sol-green", needs_input: "bg-sol-orange", done: "bg-sol-green",
  in_progress: "bg-sol-yellow", in_review: "bg-sol-violet", blocked: "bg-sol-orange",
  permission_blocked: "bg-sol-orange", active: "bg-sol-blue",
};

type SuggestionItem = Omit<MentionItem, "id"> & { id?: string; description?: string };

// One item as the popup shows it: the row fields the list was built with,
// overlaid with the live store row (a session's state and title move while the
// popup is open), plus the persona a personified session is offered as.
function useLiveMention(item: SuggestionItem) {
  const now = useCoarseNow(15_000);
  const liveJson = useInboxStore((s) => {
    const id = item.id ?? "";
    if (item.type === "session" && s.sessions[id]) {
      const row = s.sessions[id];
      const live = deriveLiveAt(liveFactsOf(row), now);
      const verdict = rankVerdictOf({ ...row, ...live, agent_status: (live.agent_status ?? undefined) as typeof row.agent_status, is_connected: live.daemon_alive }, placeInboxRows(s, { now }).placements.get(id));
      const status = !verdict.idle ? "working" : verdict.waiting ? verdict.rest : "idle";
      return JSON.stringify({
        label: row.title || "Untitled Session", status, messageCount: row.message_count,
        identity: identityRowOf(row as never),
        projectPath: row.git_root || row.project_path, agentType: row.agent_type,
        model: row.model ?? undefined, idleSummary: row.idle_summary, updatedAt: row.updated_at,
      });
    }
    if (item.type === "task" && s.tasks[id]) {
      const row = s.tasks[id];
      return JSON.stringify({ label: row.title, status: taskStatusOf(row, statusesForTeam(s.teams, row.team_id)).name, priority: row.priority, updatedAt: row.updated_at });
    }
    if (item.type === "plan" && s.plans[id]) {
      const row = s.plans[id];
      return JSON.stringify({ label: row.title, status: row.status, goal: row.goal, updatedAt: row.updated_at });
    }
    if (item.type === "doc" && s.docs[id]) {
      const row = s.docs[id];
      return JSON.stringify({ label: row.title, docType: row.doc_type, updatedAt: row.updated_at });
    }
    return "{}";
  });
  const current = { ...item, ...JSON.parse(liveJson) } as SuggestionItem;
  const config = TYPES[current.type as keyof typeof TYPES] ?? TYPES.doc;
  // A session that wears a character or a role is offered as that person: its
  // face in place of the session glyph, its name first, and the title demoted
  // to the detail (session-characters.md S3). A session nobody personified
  // reads exactly as it did before.
  const personifyAll = usePersonifyAll();
  const identityRow = current.type === "session" ? current.identity ?? null : null;
  const persona = identityRow && sessionIdentity(identityRow, personifyAll).kind !== "plain"
    ? identityLine(identityRow, current.label, personifyAll)
    : null;
  const status = current.type === "person" || (current.type === "session" && liveJson === "{}") ? undefined : current.status;

  const name = persona?.name
    ?? (current.type === "file" ? current.label.split("/").pop() ?? current.label : current.label);

  // The meta run after the name: what kind of thing it is and where it lives.
  const meta: string[] = [];
  if (persona?.title) meta.push(persona.title);
  if (persona?.handle) meta.push(`@${persona.handle}`);
  if (current.type === "session") {
    if (current.agentType) meta.push(agentDisplayName(current.agentType));
    const model = modelDisplayLabel(current.agentType, current.model);
    if (model) meta.push(model);
    const project = current.projectPath?.split("/").filter(Boolean).pop();
    if (project) meta.push(project);
    if (current.messageCount != null) meta.push(`${current.messageCount} msg${current.messageCount === 1 ? "" : "s"}`);
  } else if (current.type === "task") {
    if (current.priority && current.priority !== "none") meta.push(current.priority);
  } else if (current.type === "file") {
    const parent = current.label.replace(/\/[^/]+$/, "");
    if (parent !== current.label) meta.push(parent);
  } else if (current.type === "doc") meta.push(current.docType || "note");
  else if (current.type === "channel") {
    if (current.channelKind && current.channelKind !== "public") meta.push(current.channelKind);
    if (current.sublabel) meta.push(current.sublabel);
  } else if (current.type === "person" || current.type === "role") {
    if (current.sublabel) meta.push(current.sublabel);
  } else if (current.sublabel || current.description) meta.push(current.sublabel || current.description!);

  // The trailing mono token: the id you would type to reach it again.
  const token = current.type === "task" || current.type === "plan" ? current.shortId
    : current.type === "session" ? current.shortId
    : undefined;
  const summary = current.type === "session" ? current.idleSummary
    : current.type === "plan" ? current.goal
    : current.type === "channel" ? current.sublabel
    : current.type === "skill" ? current.description
    : current.type === "file" ? current.label
    : undefined;
  const time = current.viewedAt || current.updatedAt;
  const timeLabel = current.viewedAt ? "Viewed" : current.type === "channel" ? "Active" : "Updated";
  const Icon = current.isBot ? Bot : current.type === "channel" && current.channelKind === "private" ? Lock : config.icon;
  return { current, config, Icon, persona, identityRow, status, name, meta, token, summary, time, timeLabel };
}

// The query's words inside a name, marked so the eye lands on why it matched.
function Highlighted({ text, query }: { text: string; query?: string }) {
  const words = (query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    const at = lower.indexOf(w);
    if (at >= 0) for (let i = at; i < at + w.length; i++) marks[i] = true;
  }
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const on = marks[i];
    let j = i;
    while (j < text.length && marks[j] === on) j++;
    out.push(on
      ? <mark key={i} className="bg-sol-yellow/25 text-inherit rounded-[2px]">{text.slice(i, j)}</mark>
      : text.slice(i, j));
    i = j;
  }
  return <>{out}</>;
}

function Glyph({ live, size }: { live: ReturnType<typeof useLiveMention>; size: number }) {
  const { persona, identityRow, current, Icon, config } = live;
  if (persona && identityRow) return <SessionFace row={identityRow} size={size} className="shrink-0" />;
  if (current.image) return <AvatarImg src={current.image} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />;
  return <Icon aria-hidden className={`shrink-0 ${config.color}`} style={{ width: size - 4, height: size - 4, margin: 2 }} />;
}

function StatusDot({ status }: { status?: string }) {
  if (!status) return null;
  const key = status.toLowerCase().replace(/ /g, "_");
  const color = STATE_DOTS[key] ?? "bg-sol-text-dim/50";
  return (
    <span className="shrink-0 inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-sol-text-dim" title={status.replace(/_/g, " ")}>
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${key === "working" ? "animate-pulse" : ""}`} />
      <span className="hidden sm:inline">{status.replace(/_/g, " ")}</span>
    </span>
  );
}

/** One dense row of the popup: glyph, name, a dim meta run, the id and age. */
export function MentionSuggestion({ item, query }: { item: SuggestionItem; query?: string }) {
  const live = useLiveMention(item);
  const { current, status, name, meta, token, time, timeLabel } = live;
  return (
    <>
      <Glyph live={live} size={18} />
      <span className="min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
        <span className="text-[13px] leading-5 text-sol-text truncate shrink-0 max-w-[70%]" title={current.label}>
          <Highlighted text={name} query={query} />
        </span>
        {current.slack && <SlackLogo className="w-3 h-3 shrink-0" title="In Slack only, paged there" />}
        <StatusDot status={status} />
        {meta.length > 0 && <span className="text-[11px] text-sol-text-dim truncate min-w-0" title={meta.join(" · ")}>{meta.join(" · ")}</span>}
      </span>
      {current.unread ? <span className="shrink-0 text-[10px] tabular-nums px-1.5 rounded-full bg-sol-blue/15 text-sol-blue">{current.unread}</span> : null}
      {token && <span className="shrink-0 font-mono text-[10px] text-sol-text-dim/80">{token}</span>}
      {time ? <span className="shrink-0 min-w-[2.5rem] whitespace-nowrap text-right text-[10px] text-sol-text-dim tabular-nums" title={`${timeLabel} ${new Date(time).toLocaleString()}`}>{visitTimeAgo(time)}</span> : null}
    </>
  );
}

/** The highlighted item in full: the whole name, what it is, and its summary. */
export function MentionDetail({ item }: { item: SuggestionItem }) {
  const live = useLiveMention(item);
  const { current, config, name, meta, summary, time, timeLabel, status } = live;
  const kind = [live.persona ? "Session" : config.label, status?.replace(/_/g, " "), ...meta.filter((m) => m !== summary)].filter(Boolean).join(" · ");
  const title = current.type === "channel" ? `#${name}` : current.type === "file" ? current.label : name;
  return (
    <div className="flex gap-2.5 px-3 py-2 h-[70px] overflow-hidden">
      <Glyph live={live} size={22} />
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-[12px] leading-4 font-medium text-sol-text line-clamp-2 break-words">{title}</span>
        {summary && summary !== title && <span className="text-[11px] leading-4 text-sol-text-muted truncate">{summary}</span>}
        <span className="mt-auto flex items-center gap-2 text-[10px] text-sol-text-dim min-w-0">
          <span className="truncate">{kind}</span>
          {time ? <span className="ml-auto shrink-0 whitespace-nowrap">{timeLabel.toLowerCase()} {visitTimeAgo(time)}</span> : null}
        </span>
      </div>
    </div>
  );
}
