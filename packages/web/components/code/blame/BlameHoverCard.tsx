// What a blame hunk is: the session that wrote it (a live reference), the
// agent, when, the commit, the lines, and the ways into it.

import { useState } from "react";
import { Check, Columns2, Copy, GitCommitHorizontal } from "lucide-react";
import { EntityIdPill } from "../../EntityIdPill";
import { AgentTypeIcon, formatAgentType } from "../../AgentTypeIcon";
import { Button } from "../../ui/button";
import { useInboxStore } from "../../../store/inboxStore";
import { blameViaLabel, isBlameVia } from "../../../lib/repoView";
import { copyToClipboard, formatDateFull, formatRelative } from "../../../lib/utils";
import { openBlameSession } from "../../../lib/code/blame/actions";
import { closeBlameHover, type BlameHover } from "../../../lib/code/blame/hover";
import { runName } from "../../../lib/code/blame/model";

export function BlameHoverCard({ hover }: { hover: BlameHover }) {
  const { run, hue } = hover;
  const hunk = run.hunk;
  const session = hunk?.session;
  const conversationId = session?.conversation_id ?? null;
  const agent = useInboxStore((s) => (conversationId ? s.sessions[conversationId]?.agent_type : undefined)) ?? session?.agent;
  const [copied, setCopied] = useState(false);
  const lines = run.toLine - run.fromLine + 1;
  const via = isBlameVia(session?.via) ? blameViaLabel(session.via) : undefined;

  return (
    <div className="relative flex flex-col gap-2 py-2.5 pl-4 pr-3 text-xs" style={{ "--blame-hue": hue } as React.CSSProperties}>
      <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-sm" style={{ background: "var(--blame-hue)" }} />

      <div className="flex min-w-0 items-center gap-2" title={via}>
        {session && conversationId ? (
          <EntityIdPill type="session" id={conversationId} label={session.title ?? session.id} wide />
        ) : (
          <span className="truncate font-medium text-sol-text">{runName(run.kind, hunk)}</span>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-2 text-sol-text-muted">
        {agent && (
          <span className="flex shrink-0 items-center gap-1">
            <AgentTypeIcon agentType={agent} />
            {formatAgentType(agent)}
          </span>
        )}
        {/* A plain commit's title is already its author. */}
        {session?.author_name && <span className="truncate">{session.author_name}</span>}
        {run.kind === "edited" ? (
          <span className="shrink-0 text-sol-text-dim">edited now</span>
        ) : hunk?.time ? (
          <span className="ml-auto shrink-0 tabular-nums text-sol-text-dim" title={formatDateFull(hunk.time)}>
            {formatRelative(hunk.time)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2 text-sol-text-muted">
        <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 opacity-60" />
        {hunk?.sha ? (
          <>
            <span className="shrink-0 font-mono text-sol-text">{hunk.sha.slice(0, 7)}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="-mx-1 shrink-0 text-sol-text-dim"
              title={copied ? "Copied" : "Copy sha"}
              aria-label="Copy sha"
              onClick={() => {
                void copyToClipboard(hunk.sha!).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
            <span className="truncate" title={hunk.summary}>{hunk.summary}</span>
          </>
        ) : (
          <span className="text-sol-text-dim">Not committed</span>
        )}
        <span className="ml-auto shrink-0 font-mono tabular-nums text-sol-text-dim" title={`${lines} ${lines === 1 ? "line" : "lines"}`}>
          {run.fromLine === run.toLine ? `L${run.fromLine}` : `L${run.fromLine}–${run.toLine}`}
        </span>
      </div>

      {conversationId && (
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              openBlameSession(session);
              closeBlameHover();
            }}
          >
            <Columns2 /> Open beside
          </Button>
        </div>
      )}
    </div>
  );
}
