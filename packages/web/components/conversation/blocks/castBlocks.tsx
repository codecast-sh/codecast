import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useMemo, useContext } from "react";
import { useChatMessageRow, useEnsureChatMessage } from "../../../hooks/useChatSync";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { BrowserTabPill } from "../../browser/BrowserTabPill";
import { parseThreadStateStatus } from "@codecast/shared/contracts";
import { truncateStr } from "@codecast/shared/render";
import { entityRoute } from "../../../lib/entityLinks";
import { parseTriggerCadence } from "../../triggerCadence";
import { CollapsibleBody } from "../../CollapsibleBody";
import { useQuery } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { findEntityInStore } from "../../../lib/liveEntities";
import { EntityIdPill } from "../../EntityIdPill";
import { THREAD_STATE_STATUS_META } from "../../../lib/threadState";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS } from "../../messageMarkdown";
import { extractSendBody, extractChatSendArgs, normalizeCastCategory, extractCastBodyParts, extractStateArgs, extractBrowserDoSteps, splitBrowserDoOutput, extractDecideArgs, browserTabOf, type CastBodyPart, type ChatSendArgs, type DecideArgs } from "../../castCommand";
import { useInboxStore, useTrackedStore, type SessionDecisionItem } from "../../../store/inboxStore";
import { DocDates } from "../../DocDates";
import { FileText, CornerUpRight, BookOpen, Check, Split, Pin } from "lucide-react";
import { ImageBlock } from "./interactiveBlocks";
import { CastBrowserRowContext, ChatWakeContext } from "../../../lib/conversationBlockContexts";
import { NestedStepList } from "./shared";
import { ChatChannelPill } from "./systemBlocks";
import { chatHref } from "../../../lib/chatHref";
import { BrowserWatchButton } from "./toolBlocks";
import { decideOutputId, parseCastCommand } from "../classify";
import { renderAnsi } from "../../../lib/conversationFormat";
import { MessageMarkdown, ReactMarkdown } from "../markdown";
import type { ImageData, ToolCall, ToolResult } from "../types";

const api = _typedApi as any;

const CAST_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-gray-500/10", text: "text-gray-400" },
  open: { bg: "bg-sol-blue/10", text: "text-sol-blue" },
  backlog: { bg: "bg-gray-500/10", text: "text-gray-400" },
  in_progress: { bg: "bg-sol-yellow/10", text: "text-sol-yellow" },
  in_review: { bg: "bg-sol-violet/10", text: "text-sol-violet" },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  dropped: { bg: "bg-gray-500/10", text: "text-gray-400" },
  active: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  paused: { bg: "bg-gray-500/10", text: "text-gray-400" },
  abandoned: { bg: "bg-red-500/10", text: "text-red-400" },
};

function DocTitleLink({ convexId }: { convexId: string }) {
  const router = useRouter();
  // Local-first seed (same pattern as EntityIdPill): the store usually holds
  // the doc row already — paint the title on the first frame instead of
  // flashing a truncated raw id. Non-reactive read; the query keeps it fresh.
  const seed = useMemo(() => findEntityInStore(useInboxStore.getState(), "doc", convexId), [convexId]);
  const queryDoc = useQuery(api.docs.webGet, { id: convexId });
  const doc = queryDoc ?? seed;
  if (!doc) return <span className="text-sol-text-dim font-mono">{convexId.slice(0, 12)}...</span>;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); router.push(`/docs/${doc._id}`); }}
      className="text-sol-blue hover:underline truncate max-w-[250px] text-left"
    >
      {(doc as any).display_title || doc.title}
    </button>
  );
}

// Resolved title of a task/plan, rendered inline after its id pill in a cast
// command row. `struck` crosses it out — a `task done` row reads as the task
// being checked off. Enrichment only: the row is honest without it, so the
// queries go through useQueryNoThrow and an unresolved title renders nothing.
function InlineEntityTitle({ shortId, struck }: { shortId: string; struck?: boolean }) {
  const isPlan = shortId.startsWith("pl-");
  // Local-first seed: paint the resolved title on the first frame when the
  // store already holds the row (it usually does — same rule as EntityIdPill).
  const seed = useMemo(
    () => findEntityInStore(useInboxStore.getState(), isPlan ? "plan" : "task", shortId),
    [isPlan, shortId],
  );
  const { data: task } = useQueryNoThrow(api.tasks.webGet, !isPlan ? { short_id: shortId } : "skip");
  const { data: plan } = useQueryNoThrow(api.plans.webGet, isPlan ? { short_id: shortId } : "skip");
  const entity: any = (isPlan ? plan : task) ?? seed;
  const title = entity?.display_title || entity?.title;
  if (!title) return null;
  return (
    <span className={`truncate max-w-[280px] ${struck ? "line-through text-sol-text-dim" : "text-sol-text-muted"}`}>
      {title}
    </span>
  );
}

function CastEntityCard({ type, shortId, convexId }: { type: "task" | "plan" | "doc"; shortId?: string; convexId?: string }) {
  const router = useRouter();
  // Local-first seed: the card paints from the store's row on the first
  // frame; the query refreshes it. Every `cast task/plan/doc` row in a
  // transcript renders this, so the flash was everywhere.
  const rawId = convexId ?? shortId ?? "";
  const seed = useMemo(
    () => (rawId ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [type, rawId],
  );
  const task = useQuery(api.tasks.webGet, type === "task" && shortId ? { short_id: shortId } : "skip");
  const plan = useQuery(api.plans.webGet, type === "plan" && shortId ? { short_id: shortId } : "skip");
  const doc = useQuery(api.docs.webGet, type === "doc" && convexId ? { id: convexId } : "skip");
  const entity = (type === "task" ? task : type === "plan" ? plan : doc) ?? seed;

  if (!entity) {
    if (shortId) return <EntityIdPill shortId={shortId} />;
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const route = entityRoute(type, entity._id);
    if (route) router.push(route);
  };

  const status = entity.status || (type === "doc" ? null : "open");
  const sc = status ? (CAST_STATUS_COLORS[status] || CAST_STATUS_COLORS.open) : null;
  const age = Date.now() - (entity.updated_at || (entity as any)._creationTime || Date.now());
  const ageStr = age < 3600000 ? `${Math.max(1, Math.round(age / 60000))}m`
    : age < 86400000 ? `${Math.round(age / 3600000)}h`
    : `${Math.round(age / 86400000)}d`;

  const borderColor = type === "plan" ? "border-sol-cyan/20 bg-sol-cyan/5 hover:bg-sol-cyan/10"
    : type === "task" ? "border-sol-violet/20 bg-sol-violet/5 hover:bg-sol-violet/10"
    : "border-sol-blue/20 bg-sol-blue/5 hover:bg-sol-blue/10";

  const DOC_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    plan: { label: "Plan", color: "text-sol-cyan" },
    design: { label: "Design", color: "text-sol-violet" },
    spec: { label: "Spec", color: "text-sol-blue" },
    investigation: { label: "Investigation", color: "text-sol-orange" },
    handoff: { label: "Handoff", color: "text-sol-magenta" },
    note: { label: "Note", color: "text-sol-text-dim" },
  };

  const docPreview = type === "doc" && (entity as any).content
    ? (entity as any).content.replace(/^#[^\n]*\n*/m, "").replace(/\\n/g, " ").replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120)
    : "";

  return (
    <button onClick={handleClick} className={`mt-1 w-full max-w-md text-left rounded-lg border transition-colors cursor-pointer ${borderColor}`}>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {sc && (
            <span className={`px-1.5 py-0 rounded text-[10px] font-mono ${sc.bg} ${sc.text}`}>
              {status!.replace(/_/g, " ")}
            </span>
          )}
          {type === "doc" && (entity as any).doc_type && (
            <span className={`text-[10px] font-medium ${DOC_TYPE_LABELS[(entity as any).doc_type]?.color || "text-sol-text-dim"}`}>
              {DOC_TYPE_LABELS[(entity as any).doc_type]?.label || (entity as any).doc_type}
            </span>
          )}
          {shortId && <span className="text-[10px] font-mono text-sol-text-dim">{shortId}</span>}
          <span className="flex-1 text-sm text-sol-text truncate">
            {(entity as any).display_title || entity.title}
          </span>
          {type === "doc" && (entity as any).created_at ? (
            <DocDates doc={entity as any} className="text-[10px] text-sol-text-dim flex-shrink-0" />
          ) : (
            <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{ageStr}</span>
          )}
        </div>
        {type === "plan" && (entity as any).progress && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1 rounded-full bg-sol-bg-highlight overflow-hidden max-w-[200px]">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all"
                style={{ width: `${(entity as any).progress.total > 0 ? Math.round(((entity as any).progress.done / (entity as any).progress.total) * 100) : 0}%` }}
              />
            </div>
            <span className="text-[10px] text-sol-text-dim font-mono">
              {(entity as any).progress.done}/{(entity as any).progress.total}
            </span>
          </div>
        )}
        {type === "task" && (
          <div className="flex items-center gap-1.5 mt-1">
            {(entity as any).priority && (entity as any).priority !== "medium" && (
              <span className={`text-[10px] px-1 py-0 rounded font-mono ${
                (entity as any).priority === "high" || (entity as any).priority === "critical"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-gray-500/10 text-gray-400"
              }`}>{(entity as any).priority}</span>
            )}
            {(entity as any).labels?.map((l: string) => (
              <span key={l} className="text-[10px] px-1.5 py-0 rounded-full bg-sol-bg-highlight text-sol-text-dim">{l}</span>
            ))}
          </div>
        )}
        {type === "doc" && docPreview && (
          <p className="text-[11px] text-sol-text-muted/70 mt-1 truncate">{docPreview}</p>
        )}
      </div>
    </button>
  );
}

// Dedicated rendering for the two session-addressed cast commands:
//   cast send <id> "<body>"   → outgoing twin of the incoming SessionMessageBlock
//   cast read <id> <range>    → compact "read" row with a clickable target pill
// Both render the target session as an EntityIdPill (clickable card), so they read
// as conversations between sessions rather than opaque shell invocations.
function CastSessionRefBlock({ cat, target, args, rawCmd, output, isError }: {
  cat: string; target: string; args: string; rawCmd: string; output: string; isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (cat === "send") {
    const { body, kind } = extractSendBody(args);
    return (
      <div className="my-2 mx-1 rounded border-l-2 border-sol-blue/60 bg-sol-blue/5">
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <CornerUpRight className="w-3.5 h-3.5 text-sol-blue/70 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-blue/70 shrink-0">Message to</span>
          <EntityIdPill shortId={target} />
          {isError ? (
            <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">failed</span>
          ) : (
            <span className="text-sol-green/70 text-[10px] ml-auto shrink-0 inline-flex items-center gap-0.5"><Check className="w-3 h-3" />sent</span>
          )}
        </div>
        {kind === "dynamic" ? (
          // The shell computed the real payload ($(…), $VAR, or stdin) before cast
          // ran — the transcript only holds the recipe. Don't dress it up as the
          // delivered message; that misled a sender into resending a 16KB briefing.
          <div className="px-3 pb-2">
            <code className="text-xs font-mono text-sol-text-secondary break-all">{body}</code>
            <div className="text-[10px] text-sol-text-dim mt-1">shown as typed — the shell filled in the actual message; open the target session to read what arrived</div>
          </div>
        ) : (
          <div className="px-3 pb-2 text-sm text-sol-text prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
              components={MESSAGE_MD_COMPONENTS}
            >{body}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  // cast read <id> <range>
  const range = args.trim();
  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-violet/80">
          <BookOpen className="w-3 h-3" />
          <span className="group-hover:underline">read</span>
        </span>
        <EntityIdPill shortId={target} />
        {range && <span className="text-sol-text-dim font-mono">{range}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>
      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {rawCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

// The prose a cast mutation carried — a comment, a done note, a plan goal, a
// trigger prompt. It is the content of the action, so it renders the way a
// message body does (markdown, entity pills, code) instead of as one clipped
// italic line: these are often written reports, and the sentence that survived a
// 90-character cut was rarely the one worth reading. Long bodies start clipped
// with an Expand toggle, so a row still costs a few lines in the transcript.
// A collapsed body shows about four lines whatever its length, and a cast
// comment can be a 20KB report — parsing all of it to paint four lines is the
// kind of per-row cost that adds up to a frozen transcript. Slice to a few
// screens' worth while clipped; the full text renders when the reader expands.
const CAST_BODY_CLIP = 2000;
function clipBody(text: string): string {
  return text.length > CAST_BODY_CLIP ? text.slice(0, CAST_BODY_CLIP) : text;
}

function CastMutationBody({ parts, accent }: { parts: CastBodyPart[]; accent: string }) {
  return (
    <div className={`mt-1 ml-1 border-l-2 pl-2.5 space-y-1.5 ${accent}`}>
      {parts.map((part, i) => (
        <div key={i}>
          {part.label && (
            <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-0.5">{part.label}</div>
          )}
          <CollapsibleBody collapsedHeight={96} toggleClassName="mt-1">
            {(expanded) => (
              <div className="text-[13px] text-sol-text prose prose-invert prose-sm max-w-none
                prose-code:text-sol-cyan prose-code:bg-sol-bg-highlight prose-code:px-1 prose-code:rounded prose-code:text-xs
                prose-code:before:content-none prose-code:after:content-none
                [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                <MessageMarkdown content={expanded ? part.text : clipBody(part.text)} userText />
              </div>
            )}
          </CollapsibleBody>
        </div>
      ))}
    </div>
  );
}

// `cast state …` pins the thread state that already renders expanded above the
// composer (ThreadStatePanel), so the row stays one line: the declared status
// as a chip in the panel's own colors, plus the state's first line. The full
// body would be the same text twice — click still expands the raw command.
function CastStateBlock({ subcommand, args, rawCmd, output, isError }: { subcommand: string; args: string; rawCmd: string; output: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // `clear`/`show` parse into the subcommand slot; the pinning form's args
  // start with `--status` or a quoted body, so its subcommand is usually empty.
  // A bare first word of an unquoted state text also lands there — fold it back.
  const verb = subcommand === "clear" || subcommand === "show" ? subcommand : null;
  const { status, headline } = useMemo(
    () => (verb ? { status: null, headline: null } : extractStateArgs(subcommand ? `${subcommand} ${args}`.trim() : args)),
    [verb, subcommand, args],
  );
  const statusMeta = (() => {
    const parsed = parseThreadStateStatus(status);
    return parsed ? THREAD_STATE_STATUS_META[parsed] : null;
  })();

  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-cyan/80">
          <Pin className="w-3 h-3" strokeWidth={2.2} />
          <span className="group-hover:underline">state{verb ? ` ${verb}` : ""}</span>
        </span>
        {statusMeta && (
          <span className={`self-center shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${statusMeta.chip}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {statusMeta.label}
          </span>
        )}
        {headline && <span className="text-sol-text-muted truncate min-w-0">{headline}</span>}
        {verb === "show" && args && <span className="text-sol-text-dim font-mono">{args.split(/\s+/)[0]}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>
      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {rawCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

// `cast decide` — the agent handing its human a decision. The queue and the
// docked SessionDecisionCard are where it gets ANSWERED; this row is the
// record of it in the transcript, rendered as the same card so the agent never
// has to restate the question in prose. The live row (store, fed by
// listForUser) is the truth when present: an edit changes the text here, an
// answer shows up as the chosen option, a withdrawal greys it out. Rows older
// than the subscription window fall back to the recorded argv.
const DECIDE_STATUS_META: Record<string, { label: string; chip: string; accent: string }> = {
  waiting: { label: "waiting on you", chip: "border-sol-yellow/40 text-sol-yellow", accent: "border-sol-yellow/50" },
  advisory: { label: "advisory", chip: "border-sol-blue/40 text-sol-blue", accent: "border-sol-blue/40" },
  answered: { label: "answered", chip: "border-sol-green/40 text-sol-green", accent: "border-sol-green/40" },
  dismissed: { label: "dismissed", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-border" },
  withdrawn: { label: "withdrawn", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-border" },
  posted: { label: "posted", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-yellow/30" },
};

function CastDecideBlock({ decide, rawCmd, output, isError, conversationId }: { decide: DecideArgs; rawCmd: string; output: string; isError: boolean; conversationId?: Id<"conversations"> }) {
  const [expanded, setExpanded] = useState(false);
  const convKey = conversationId?.toString();
  const targetId = decide.decisionId ?? (output ? decideOutputId(output, decide.verb) : null);

  // Wake on this conversation's decision rows only — they change on ask,
  // edit and answer, never on heartbeat.
  const s = useTrackedStore([
    (st) => {
      if (!convKey) return "";
      let sig = "";
      for (const d of Object.values(st.sessionDecisions)) {
        if (d.conversation_id === convKey) sig += `${d._id}:${d.status}:${d.updated_at ?? 0}:${d.answer_index ?? ""}:${d.answer_text ?? ""}|`;
      }
      return sig;
    },
  ]);
  const row = useMemo((): SessionDecisionItem | null => {
    if (targetId) return s.sessionDecisions[targetId] ?? null;
    if (!convKey) return null;
    const mine = Object.values(s.sessionDecisions)
      .filter((d) => d.conversation_id === convKey)
      .sort((a, b) => b.created_at - a.created_at);
    if (decide.verb === "ask") return mine.find((d) => d.question === decide.question) ?? null;
    // edit/cancel with no id acted on the session's open decision at the time.
    // A cancel left a withdrawn row behind; an edit most likely touched the row
    // that is still open. Newest of that kind, else newest overall.
    const wanted = decide.verb === "cancel" ? "withdrawn" : "pending";
    return mine.find((d) => d.status === wanted) ?? mine[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sessionDecisions, targetId, convKey, decide.verb, decide.question]);

  // An edit row is a diff, not a second copy of the card: it shows the fields
  // the command changed (from the recorded argv; the live row fills in a field
  // whose argv was a recipe). The ask row is the card itself.
  const isEdit = decide.verb === "edit";
  const question = isEdit ? decide.question : row?.question ?? decide.question;
  const options: Array<{ label: string; description?: string }> = isEdit ? decide.options : row?.options ?? decide.options;
  const context = isEdit ? decide.context : row?.context_md ?? decide.context;
  const editChanges = isEdit
    ? [decide.question && "question", decide.options.length > 0 && "options", decide.context !== null && "context", decide.report && "report", decide.blocking && "now blocking", decide.advisory && "now advisory"].filter(Boolean).join(", ")
    : "";
  const blocking = row ? row.blocking : !decide.advisory;
  const defaultOption = row ? row.default_option : decide.defaultOption;
  const reportSlug = row?.report_slug;
  const withdrawnHere = decide.verb === "cancel";

  const statusKey = row
    ? row.status === "pending" ? (blocking ? "waiting" : "advisory") : row.status
    : withdrawnHere ? "withdrawn" : "posted";
  const meta = DECIDE_STATUS_META[statusKey];
  const answerLabel = row?.status === "answered"
    ? row.answer_text ?? (row.answer_index !== undefined ? row.options[row.answer_index]?.label : undefined)
    : undefined;
  const muted = statusKey === "dismissed" || statusKey === "withdrawn";
  const verbLabel = decide.verb === "edit" ? "decision edited" : decide.verb === "cancel" ? "decision withdrawn" : "decision";


  return (
    <div className="my-1">
      <div
        className="flex items-center gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-yellow/80">
          <Split className="w-3 h-3" strokeWidth={2.2} />
          <span className="group-hover:underline">{verbLabel}</span>
        </span>
        {isEdit && <span className="text-sol-text-dim">{editChanges || "no readable change"}</span>}
        {!isError && row && (
          <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${meta.chip}`}>
            {statusKey === "waiting" && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
            {meta.label}
          </span>
        )}
        {!isEdit && answerLabel && <span className="text-sol-green truncate min-w-0">{answerLabel}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>

      {!isError && (question || context || options.length > 0 || reportSlug || decide.report) && (
        <div className={`mt-1 ml-1 border-l-2 pl-2.5 space-y-1.5 ${meta.accent} ${muted ? "opacity-60" : ""}`}>
          {question && (
            <div className={`text-[13px] text-sol-text leading-snug ${withdrawnHere || statusKey === "withdrawn" ? "line-through" : ""}`}>
              {question}
            </div>
          )}
          {!withdrawnHere && context && (
            <CollapsibleBody collapsedHeight={96} toggleClassName="mt-1">
              {(isOpen) => (
                <div className="text-[13px] text-sol-text-muted prose prose-invert prose-sm max-w-none
                  prose-code:text-sol-cyan prose-code:bg-sol-bg-highlight prose-code:px-1 prose-code:rounded prose-code:text-xs
                  prose-code:before:content-none prose-code:after:content-none
                  [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                  <MessageMarkdown content={isOpen ? context : clipBody(context)} userText />
                </div>
              )}
            </CollapsibleBody>
          )}
          {!withdrawnHere && options.length > 0 && (
            <div className="flex flex-col gap-1">
              {options.map((o, i) => {
                const chosen = row?.status === "answered" && row.answer_index === i;
                const isDefault = statusKey === "advisory" && defaultOption === i;
                return (
                  <div key={i} className={`flex items-baseline gap-2 text-[12px] ${chosen ? "text-sol-green" : "text-sol-text-muted"}`}>
                    <span className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border text-[10px] font-mono ${chosen ? "border-sol-green/60 text-sol-green" : "border-sol-border text-sol-text-dim"}`}>
                      {chosen ? <Check className="w-3 h-3" strokeWidth={2.5} /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={chosen ? "text-sol-green" : "text-sol-text"}>{o.label}</span>
                      {o.description && <span className="text-sol-text-dim"> — {o.description}</span>}
                      {isDefault && <span className="ml-1.5 text-[10px] text-sol-blue">proceeding with this</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {!isEdit && row?.status === "answered" && row.answer_text && (
            <div className="text-[12px] text-sol-green">answered in their own words: {row.answer_text}</div>
          )}
          {!withdrawnHere && (decide.report || (!isEdit && reportSlug)) && (
            <div className="text-[11px]">
              {reportSlug ? (
                <a href={`/a/${reportSlug}`} target="_blank" rel="noopener noreferrer" className="text-sol-blue hover:underline inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <FileText className="w-3 h-3" /> report
                </a>
              ) : (
                <span className="text-sol-text-dim inline-flex items-center gap-1"><FileText className="w-3 h-3" /> {decide.report}</span>
              )}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {rawCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

export function CastCommandBlock({ tool, result, images, globalImageMap, conversationId }: { tool: ToolCall; result?: ToolResult; images?: ImageData[]; globalImageMap?: Record<string, ImageData[]>; conversationId?: Id<"conversations"> }) {
  const [expanded, setExpanded] = useState(false);
  const cast = parseCastCommand(tool)!;
  const { category, subcommand, args } = cast;
  const output = result?.content || "";
  const isError = result?.is_error;

  const cat = normalizeCastCategory(category);
  const isCreate = subcommand === "create" || subcommand === "add";
  const bodyParts = useMemo(
    () => extractCastBodyParts(category, subcommand, args),
    [category, subcommand, args]
  );

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const entityIds = useMemo(() => {
    const ids: string[] = [];
    const patterns = [/\b(ct-[a-z0-9]+)\b/gi, /\b(pl-[a-z0-9]+)\b/gi];
    const sources = [args, stripAnsi(output)];
    for (const src of sources) {
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(src)) !== null) {
          if (!ids.includes(m[1].toLowerCase())) ids.push(m[1].toLowerCase());
        }
      }
    }
    return ids;
  }, [args, output]);

  const scheduleCadence = useMemo(
    () => (cat === "trigger" && isCreate ? parseTriggerCadence(args) : null),
    [cat, isCreate, args]
  );

  // `cast browser do …` is the CLI's batch: the row lists its steps with what
  // each reported, the same shape a browser_batch tool call renders in.
  const doSteps = useMemo(
    () => (cat === "browser" && subcommand === "do" ? extractBrowserDoSteps(args) : []),
    [cat, subcommand, args],
  );
  const doOutcomes = useMemo(
    () => (doSteps.length > 0 && output ? splitBrowserDoOutput(output, doSteps.length) : undefined),
    [doSteps.length, output],
  );
  const doFooter = useMemo(
    () => (doSteps.length > 0 ? (stripAnsi(output).match(/^\d+\/\d+ steps in .*$/m)?.[0] ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doSteps.length, output],
  );

  const docConvexId = useMemo(() => {
    if (cat !== "doc") return null;
    const fa = args?.match(/^"([^"]*)"/) || args?.match(/^'([^']*)'/) || args?.match(/^(\S+)/);
    const firstA = fa ? fa[1] : "";
    if (!isCreate && firstA && /^[a-z0-9]{20,}$/i.test(firstA)) return firstA;
    if (isCreate && output) {
      const clean = stripAnsi(output);
      const m = clean.match(/Created\s+\w+\s+([a-z0-9]{20,})/i) || clean.match(/\b([a-z0-9]{20,})\b/i);
      return m ? m[1] : null;
    }
    return null;
  }, [cat, isCreate, output, args]);

  const isEntityCommand = ((cat === "task" || cat === "plan") && isCreate && entityIds.length > 0) || (cat === "doc" && !!docConvexId);

  // `accent` tints the left rule of the body block, so a comment reads as
  // belonging to the object kind named in the row above it.
  const getCategoryConfig = () => {
    switch (cat) {
      case "task": return {
        color: "text-sol-yellow/80",
        accent: "border-sol-yellow/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
      };
      case "plan": return {
        color: "text-sol-cyan/80",
        accent: "border-sol-cyan/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
      };
      case "doc": return {
        color: "text-sol-blue/80",
        accent: "border-sol-blue/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      };
      case "search": return {
        color: "text-sol-violet/80",
        accent: "border-sol-violet/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
      };
      case "feed": return {
        color: "text-sol-green/80",
        accent: "border-sol-green/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
      };
      case "trigger": return {
        color: "text-sol-orange/80",
        accent: "border-sol-orange/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
      };
      case "browser": return {
        color: "text-sol-cyan/80",
        accent: "border-sol-cyan/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" /></svg>
      };
      case "diff": case "summary": case "handoff": case "context": case "ask": return {
        color: "text-sol-magenta/80",
        accent: "border-sol-magenta/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
      };
      default: return {
        color: "text-sol-text-dim",
        accent: "border-sol-border/60",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      };
    }
  };

  const config = getCategoryConfig();

  const firstArg = useMemo(() => {
    if (!args) return "";
    const m = args.match(/^"([^"]*)"/) || args.match(/^'([^']*)'/) || args.match(/^(\S+)/);
    // A lone `-` is the stdin marker, not a title — the body it stands for
    // renders below the row.
    return m && m[1] !== "-" ? m[1] : "";
  }, [args]);

  // `cast browser …` drives a page in the cloned Chrome. The CLI prints the
  // page URL and the tab id ("tab 4A2CDC7E") only after some verbs, so the
  // row's own output wins when it has them, and otherwise the
  // conversation-level carry-forward map supplies the page and tab the browser
  // was already on (see CastBrowserRowContext).
  const carriedBrowserRows = useContext(CastBrowserRowContext);
  const browserTab = useMemo(() => browserTabOf(tool, cast, output, carriedBrowserRows), [tool, output, carriedBrowserRows]);

  const renderSummary = () => {
    const isShow = subcommand === "show" || subcommand === "status" || subcommand === "context";
    const isGet = subcommand === "get";
    const isList = subcommand === "ls" || subcommand === "list";
    const isSearch = subcommand === "search" || cat === "search";
    const isStatusChange = ["start", "done", "drop", "pause", "activate", "bind", "unbind"].includes(subcommand);
    const isIdCommand = ["edit", "get", "show", "status", "context", "comment", "start", "done", "drop", "pause", "activate", "bind", "unbind", "update", "decide", "discover", "pointer", "decompose", "orchestrate", "autopilot", "wave", "progress", "agents", "kill", "retry"].includes(subcommand);
    // A done/drop row reads as the task being crossed out: resolved title struck
    // through, no redundant status badge (the row label already says "task done").
    const isDoneLike = subcommand === "done" || subcommand === "drop";
    const argEntityId = /^(ct|pl)-[a-z0-9]+$/i.test(firstArg) ? firstArg.toLowerCase() : null;

    const statusColors: Record<string, string> = {
      start: "bg-amber-500/15 text-amber-400",
      done: "bg-emerald-500/15 text-emerald-400",
      drop: "bg-red-500/15 text-red-400",
      pause: "bg-gray-500/15 text-gray-400",
      activate: "bg-emerald-500/15 text-emerald-400",
      bind: "bg-sol-cyan/15 text-sol-cyan",
      unbind: "bg-gray-500/15 text-gray-400",
    };

    const outputLines = output.trim().split("\n").filter(l => l.trim()).length;

    if (isEntityCommand && entityIds.length > 0 && cat !== "doc") return null;

    if (cat === "doc" && docConvexId) {
      return (
        <>
          <DocTitleLink convexId={docConvexId} />
          {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
        </>
      );
    }

    return (
      <>
        {scheduleCadence && (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-sol-orange/15 text-sol-orange/90 flex-shrink-0">
            {scheduleCadence}
          </span>
        )}

        {entityIds.length > 0 && entityIds.map(id => (
          <EntityIdPill key={id} shortId={id} />
        ))}

        {argEntityId && (isStatusChange || subcommand === "comment") && (
          <InlineEntityTitle shortId={argEntityId} struck={isDoneLike} />
        )}

        {isCreate && !entityIds.length && firstArg && (
          <span className="text-sol-text-muted truncate">{truncateStr(firstArg, 50)}</span>
        )}

        {(isShow || isGet) && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isIdCommand && !isShow && !isGet && !isStatusChange && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isStatusChange && !isDoneLike && (
          <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${statusColors[subcommand] || "bg-gray-500/15 text-gray-400"}`}>
            {subcommand}
          </span>
        )}

        {isList && output && (
          <span className="text-sol-text-dim font-mono">({outputLines} items)</span>
        )}

        {isSearch && firstArg && (
          <span className="text-sol-text-muted italic truncate">"{truncateStr(firstArg, 40)}"</span>
        )}

        {doSteps.length > 0 && (
          <span className="text-sol-text-muted font-mono truncate">
            {truncateStr(`${doSteps.length} steps · ${doSteps.map(st => `${st.verb}${st.args ? ` ${st.args}` : ""}`).join(" · ")}`, 100)}
          </span>
        )}

        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}

        {!isList && !isError && !isEntityCommand && !doSteps.length && output && outputLines > 1 && (
          <span className="text-sol-text-dim font-mono">({outputLines} lines)</span>
        )}
      </>
    );
  };

  const subLabel = subcommand ? subcommand.replace(/-/g, " ") : "";

  // `cast send <id> "…"` / `cast read <id> <range>` address another session — the
  // subcommand slot holds the session short ID. Render those as their own block
  // (clickable target pill + body/range) instead of a generic shell-command row.
  const sessionTarget = (cat === "send" || cat === "read") && /^jx[a-z0-9]{5,}$/i.test(subcommand) ? subcommand : null;
  if (sessionTarget) {
    return <CastSessionRefBlock cat={cat} target={sessionTarget} args={args} rawCmd={cast.raw} output={output} isError={!!isError} />;
  }
  // `cast chat reply <id> "…"` / `cast chat send "…" --channel <id>` — the
  // agent's side of a team-chat exchange, rendered as the outgoing twin of the
  // ChatWakeBlock that asked.
  const chatSend = cat === "chat" ? extractChatSendArgs(subcommand, args) : null;
  if (chatSend) {
    return <CastChatSendBlock send={chatSend} isReply={subcommand === "reply"} isError={!!isError} />;
  }
  // `cast decide` — the decision card, live from the store row when it exists.
  // `ls` is a plain read and keeps the generic row.
  const decide = cat === "decide" ? extractDecideArgs(subcommand, args) : null;
  if (decide && decide.verb !== "ls") {
    return <CastDecideBlock decide={decide} rawCmd={cast.raw} output={output} isError={!!isError} conversationId={conversationId} />;
  }
  // `cast state` — the pinned panel already shows the full text, so the row is
  // a one-line status + headline instead of the generic body render.
  if (cat === "state") {
    return <CastStateBlock subcommand={subcommand} args={args} rawCmd={cast.raw} output={output} isError={!!isError} />;
  }

  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`flex items-center gap-1 font-mono flex-shrink-0 ${config.color}`}>
          {config.icon}
          <span className="group-hover:underline">{cat}{subLabel ? ` ${subLabel}` : ""}</span>
        </span>
        {renderSummary()}
        {browserTab && <BrowserTabPill tab={browserTab} />}
        {cat === "browser" && conversationId && (
          <BrowserWatchButton conversationId={conversationId} />
        )}
      </div>

      {(() => {
        // A `cast browser shot` declares the file it wrote via an inline-image
        // marker; the parser lifts it onto the message keyed by this tool call
        // (see cli inlineImage.ts). Bind it here the same way ToolBlock does,
        // so the screenshot renders under the row like an extension shot —
        // several at once (`--viewports`) read side by side as a comparison.
        let toolImages = images?.filter(img => img.tool_use_id === tool.id) ?? [];
        if (!toolImages.length) toolImages = globalImageMap?.[tool.id] ?? [];
        if (!toolImages.length) return null;
        if (toolImages.length === 1) return <ImageBlock image={toolImages[0]} />;
        return (
          <div className="flex gap-2 items-start">
            {toolImages.map((img, i) => (
              <div key={i} className="flex-1 min-w-0 max-w-md">
                <ImageBlock image={img} />
              </div>
            ))}
          </div>
        );
      })()}

      {bodyParts.length > 0 && <CastMutationBody parts={bodyParts} accent={config.accent} />}

      {isEntityCommand && entityIds.length > 0 && cat !== "doc" && entityIds.map(id => (
        <CastEntityCard
          key={id}
          type={id.startsWith("pl-") ? "plan" : "task"}
          shortId={id}
        />
      ))}

      {cat === "doc" && docConvexId && (
        <CastEntityCard type="doc" convexId={docConvexId} />
      )}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {cast.raw}
            </pre>
          </div>
          {doSteps.length > 0 ? (
            <>
              <NestedStepList
                steps={doSteps.map(st => ({ label: st.verb, summary: st.args }))}
                outcomes={doOutcomes}
                labelClass={config.color}
              />
              {doFooter && <div className="px-2 py-1 text-[11px] font-mono text-sol-text-dim">{doFooter}</div>}
              {!output && <div className="p-2 text-xs text-sol-text-dim">Running</div>}
            </>
          ) : output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

// The outgoing half. A reply names only the placeholder id, so the channel and
// the thread come from the chat store (fetched on demand when this client has
// not paged to that message) — the header stays honest when they are unknown.
function CastChatSendBlock({ send, isReply, isError }: { send: ChatSendArgs; isReply: boolean; isError: boolean }) {
  const wake = useContext(ChatWakeContext)[send.messageId ?? ""];
  // The wake that asked is the first source; the chat store (fetched on demand)
  // covers a reply whose wake was compacted away or a `cast chat send`.
  const lookupId = isReply && !wake ? send.messageId : undefined;
  useEnsureChatMessage(lookupId);
  const row = useChatMessageRow(lookupId);
  const channelId = send.channelId ?? wake?.channelId ?? row?.channel_id;
  const storeName = useInboxStore((s) => (channelId ? s.chatChannels[channelId]?.name : undefined));
  const channelName = wake?.channelName ?? storeName;
  const href = chatHref(channelId, isReply ? send.messageId : send.threadRootId);
  const declinedByFlag = send.status === "error";
  // The server's own verdict on the reply outranks the command's flag.
  const declined = row?.agent_status === "error" || (row?.agent_status == null && declinedByFlag);
  // A reply always lands in the thread it was asked in; only a send needs the label.
  const inThread = !isReply && !!send.threadRootId;
  return (
    <div className="my-2 mx-1 rounded border-l-2 border-sol-magenta/60 bg-sol-magenta/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <CornerUpRight className="w-3.5 h-3.5 text-sol-magenta/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-magenta/70 shrink-0">{isReply ? "Reply in chat" : "Message to chat"}</span>
        {channelName ? (
          <ChatChannelPill name={channelName} href={href} />
        ) : href ? (
          <Link href={href} className="text-[11px] font-mono text-sol-magenta hover:underline underline-offset-2">open thread</Link>
        ) : null}
        {inThread && <span className="text-[10px] text-sol-text-dim">in thread</span>}
        {isError ? (
          <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">failed</span>
        ) : declined ? (
          <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">could not answer</span>
        ) : (
          <span className="text-sol-green/70 text-[10px] ml-auto shrink-0 inline-flex items-center gap-0.5"><Check className="w-3 h-3" />sent</span>
        )}
      </div>
      {send.kind === "dynamic" ? (
        <div className="px-3 pb-2">
          <code className="text-xs font-mono text-sol-text-secondary break-all">{send.body}</code>
          <div className="text-[10px] text-sol-text-dim mt-1">shown as typed — the shell filled in the actual message; open the thread to read what arrived</div>
        </div>
      ) : (
        <div className="px-3 pb-2 text-sm text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{send.body}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
