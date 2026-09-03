import { useState } from "react";
import Link from "next/link";
import {
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Radio,
} from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { Switch } from "../ui/switch";
import { copyToClipboard } from "../../lib/utils";
import {
  accentSoft,
  accentVar,
  shepherdStyle,
  type ExternalEventAccent,
} from "../../lib/externalEvents";
import {
  PR_STATE_META,
  foldChecks,
  mergeStateMeta,
  prStateKey,
  reviewDecisionMeta,
  type PrStateKey,
} from "../../lib/prView";

// The header band: who, what, where it is going, and whether it can land.
// Everything here is one line of reading — the detail lives in the tabs.

const STATE_ICON: Record<PrStateKey, typeof GitPullRequest> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

function Chip({
  accent,
  children,
  title,
}: {
  accent: ExternalEventAccent;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium"
      style={{
        color: accentVar(accent),
        borderColor: accentSoft(accent, 35),
        background: accentSoft(accent, 12),
      }}
    >
      {children}
    </span>
  );
}

function CopyRef({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="group inline-flex items-center gap-1.5 rounded-md border border-sol-border/40 bg-sol-bg-alt/50 px-2 py-0.5 font-mono text-[11px] text-sol-text-muted hover:border-sol-border hover:text-sol-text transition-colors"
      title="Copy the branch names"
      onClick={async () => {
        await copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {text}
      {copied ? (
        <Check className="w-3 h-3 text-sol-green" />
      ) : (
        <Copy className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity" />
      )}
    </button>
  );
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 pr-5 mr-5 border-r border-sol-border/30 last:border-none last:mr-0 last:pr-0">
      <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">{label}</span>
      <span className="text-[12px] text-sol-text flex items-center gap-2">{children}</span>
    </div>
  );
}

/** The checks bar: one segment per outcome, widths animated in on load. */
function ChecksBar({ checks }: { checks: any[] | undefined }) {
  const fold = foldChecks(checks);
  if (fold.total === 0) return <span className="text-sol-text-dim">No checks</span>;
  const pct = (n: number) => `${(n / fold.total) * 100}%`;
  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="pr-seg-track w-24">
        <span className="pr-seg" style={{ width: pct(fold.passed), background: accentVar("green") }} />
        <span className="pr-seg" style={{ width: pct(fold.failed), background: accentVar("red") }} />
        <span className="pr-seg" style={{ width: pct(fold.pending), background: accentVar("yellow") }} />
        <span className="pr-seg" style={{ width: pct(fold.skipped), background: accentVar("muted") }} />
      </span>
      <span className="whitespace-nowrap">
        {fold.failed > 0 && <span className="text-sol-red">{fold.failed} failed </span>}
        {fold.pending > 0 && <span className="text-sol-yellow">{fold.pending} running </span>}
        <span className="text-sol-text-muted">{fold.passed} passed</span>
      </span>
    </span>
  );
}

/** Shepherd: the session that owns this PR until it merges. */
function ShepherdControl({
  pr,
  sessionChoices,
  onSetShepherd,
}: {
  pr: any;
  sessionChoices: { id: string; title: string }[];
  onSetShepherd: (conversationId: string | undefined, enabled: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const bound = pr.shepherd_conversation_id as string | undefined;
  const style = shepherdStyle(pr.shepherd_state);

  if (!bound) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-sol-border px-2.5 py-1 text-[11px] text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
          onClick={() => setPicking((v) => !v)}
        >
          <Radio className="w-3 h-3" />
          Shepherd with a session
        </button>
        {picking && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {sessionChoices.length === 0 ? (
              <span className="text-[11px] text-sol-text-dim">No session is linked to this PR yet</span>
            ) : (
              sessionChoices.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="rounded-full border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors max-w-[220px] truncate"
                  onClick={() => {
                    onSetShepherd(session.id, true);
                    setPicking(false);
                  }}
                >
                  {session.title}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Chip accent={style.accent} title="What the shepherd is waiting on">
        <Radio className="w-3 h-3" />
        {style.label}
      </Chip>
      <Link
        href={`/conversation/${bound}`}
        className="rounded-full border border-sol-border/50 px-2 py-0.5 font-mono text-[11px] text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors"
      >
        {sessionChoices.find((s) => s.id === bound)?.title ?? "session"}
      </Link>
      <Switch
        checked={pr.shepherd_enabled !== false}
        onCheckedChange={(on) => onSetShepherd(bound, on)}
        aria-label="Wake the shepherd session when this PR changes"
      />
    </div>
  );
}

export function PRHeader({
  pr,
  repository,
  number,
  openComments,
  sessionChoices,
  onSetShepherd,
}: {
  pr: any;
  repository: string;
  number: number;
  openComments: number;
  sessionChoices: { id: string; title: string }[];
  onSetShepherd: (conversationId: string | undefined, enabled: boolean) => void;
}) {
  const stateKey = prStateKey(pr);
  const state = PR_STATE_META[stateKey];
  const StateIcon = STATE_ICON[stateKey];
  const merge = mergeStateMeta(pr);
  const decision = reviewDecisionMeta(pr.review_decision);
  const [owner, repo] = repository.split("/");

  return (
    <header className="pr-band border-b border-sol-border/60 px-5 pt-4 pb-3 shrink-0">
      <div className="pr-rise flex items-center gap-2 text-[11px] text-sol-text-dim" style={{ ["--d" as string]: "0ms" }}>
        <span className="font-mono">{owner}</span>
        <span className="opacity-40">/</span>
        <span className="font-mono text-sol-text-muted">{repo}</span>
        <span className="opacity-40">/</span>
        <span className="font-mono text-sol-text-muted">#{number}</span>
        <a
          href={`https://github.com/${repository}/pull/${number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 inline-flex items-center gap-1 text-sol-text-dim hover:text-sol-cyan transition-colors"
          title="Open on GitHub"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="pr-rise mt-1.5 flex items-start gap-3 flex-wrap" style={{ ["--d" as string]: "60ms" }}>
        <h1 className="font-serif text-[26px] leading-tight text-sol-text min-w-0 flex-1">
          {pr.title}
        </h1>
        <div className="flex items-center gap-2 shrink-0 pt-1">
          <Chip accent={state.accent}>
            <StateIcon className="w-3.5 h-3.5" />
            {state.label}
          </Chip>
          {merge && <Chip accent={merge.accent}>{merge.label}</Chip>}
          {decision && <Chip accent={decision.accent}>{decision.label}</Chip>}
        </div>
      </div>

      <div className="pr-rise mt-2.5 flex items-center gap-3 flex-wrap" style={{ ["--d" as string]: "120ms" }}>
        <span className="flex items-center gap-1.5 text-[12px] text-sol-text-muted">
          <CommentAvatar
            name={pr.author_github_username ?? "?"}
            image={pr.author_avatar_url}
            size={18}
          />
          {pr.author_github_username}
        </span>
        {pr.head_ref && pr.base_ref && <CopyRef text={`${pr.head_ref} -> ${pr.base_ref}`} />}
        <ShepherdControl pr={pr} sessionChoices={sessionChoices} onSetShepherd={onSetShepherd} />
      </div>

      <div
        className="pr-rise mt-3 flex items-center flex-wrap gap-y-3 text-[12px]"
        style={{ ["--d" as string]: "180ms" }}
      >
        <Figure label="Checks">
          <ChecksBar checks={pr.checks} />
        </Figure>
        <Figure label="Review">
          {decision ? (
            <span style={{ color: accentVar(decision.accent) }}>{decision.label}</span>
          ) : (
            <span className="text-sol-text-dim">Nobody has reviewed yet</span>
          )}
        </Figure>
        <Figure label="Merge">
          {merge ? (
            <span style={{ color: accentVar(merge.accent) }}>{merge.label}</span>
          ) : (
            <span className="text-sol-text-dim">Unknown</span>
          )}
        </Figure>
        <Figure label="Open comments">
          <span className={openComments > 0 ? "text-sol-yellow" : "text-sol-text-muted"}>
            <CircleDot className="w-3 h-3 inline mr-1 -mt-px" />
            {openComments}
          </span>
        </Figure>
        <Figure label="Diff">
          <span className="font-mono">
            <span className="text-sol-green">+{pr.additions ?? 0}</span>
            <span className="mx-1 text-sol-text-dim/40">/</span>
            <span className="text-sol-red">-{pr.deletions ?? 0}</span>
            <span className="ml-2 text-sol-text-dim">
              {pr.changed_files ?? pr.files?.length ?? 0} files
            </span>
          </span>
        </Figure>
      </div>
    </header>
  );
}
