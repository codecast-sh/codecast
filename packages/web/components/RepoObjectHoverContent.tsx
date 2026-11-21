// The hover cards of a pull request and a commit reference (EntityIdPill):
// what the object is, where it stands in production once it is on main, and
// how big it is. Each card is links around its production rows, which are
// links of their own.
import React from "react";
import Link from "next/link";
import { ArrowUpRight, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { DiffStat } from "./entityDisplay";
import { relativeTime } from "../lib/entityDisplay";
import { parseRepoObjectId } from "../lib/entityLinks";
import { prState, repoObjectRefOf } from "../lib/repoObjects";
import { stripMarkdown } from "../lib/notificationText";

/** The parts of a repository object's card that open it: each its own link, so the production rows between them can be links too. */
export type RepoCardLink = { href: string; onOpen: (e: React.MouseEvent) => void; production: React.ReactNode; showOpen: boolean };
const CARD_LINK = "block no-underline cursor-pointer space-y-2";

// A pull request reference answers: what it is, whether it is open, merged or
// closed, who opened it, where it stands in production once merged, which
// branch goes where, and how big it is.
export function PullRequestHoverContent({ pr, href, onOpen, production, showOpen }: { pr: any } & RepoCardLink) {
  const state = prState(pr.state);
  const when = relativeTime(pr.merged_at ?? pr.updated_at);
  return (
    <div className="space-y-2">
      <Link href={href} onClick={onOpen} className={CARD_LINK}>
      <div className="flex items-start gap-2">
        <GitPullRequest className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${state.color}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{pr.title || `#${pr.number}`}</div>
          <div className="flex items-center gap-2 mt-1 text-meta">
            <span className={`font-medium ${state.color}`}>{state.label}</span>
            {pr.author_github_username && (
              <>
                <span className="text-sol-text-dim/60">·</span>
                <span className="text-sol-text-muted truncate">{pr.author_github_username}</span>
              </>
            )}
            {when && (
              <>
                <span className="text-sol-text-dim/60">·</span>
                <span className="text-sol-text-muted">{when}</span>
              </>
            )}
          </div>
        </div>
      </div>

      </Link>
      {production}
      <Link href={href} onClick={onOpen} className={CARD_LINK}>
      {pr.body && (
        <p className="text-meta text-sol-text-muted line-clamp-2 leading-relaxed pl-[22px]">
          {stripMarkdown(pr.body).slice(0, 200)}
        </p>
      )}

      {/* Where the review stands, in the three words a reader wants before
          opening it: the verdict, the checks, and what is still open. */}
      {(pr.review_decision || pr.checks_state || pr.unresolved_review_count) && (
        <div className="flex items-center gap-2 pl-[22px] text-meta min-w-0 flex-wrap">
          {pr.review_decision && pr.review_decision !== "none" && (
            <span className={pr.review_decision === "approved" ? "text-sol-green" : pr.review_decision === "changes_requested" ? "text-sol-red" : "text-sol-yellow"}>
              {pr.review_decision === "approved" ? "approved" : pr.review_decision === "changes_requested" ? "changes requested" : "review needed"}
            </span>
          )}
          {pr.checks_state && pr.checks_state !== "none" && (
            <span className={pr.checks_state === "success" ? "text-sol-green" : pr.checks_state === "failure" ? "text-sol-red" : "text-sol-yellow"}>
              checks {pr.checks_state === "success" ? "green" : pr.checks_state === "failure" ? "failing" : "running"}
            </span>
          )}
          {!!pr.unresolved_review_count && (
            <span className="text-sol-cyan">{pr.unresolved_review_count} open {pr.unresolved_review_count === 1 ? "thread" : "threads"}</span>
          )}
        </div>
      )}

      {(pr.head_ref || pr.additions != null || pr.changed_files != null) && (
        <div className="flex items-center gap-2 pl-[22px] text-meta font-mono text-sol-text-dim min-w-0">
          {pr.head_ref && (
            <span className="truncate">
              <span className="text-sol-green">{pr.head_ref}</span>
              {pr.base_ref && (
                <>
                  <span className="text-sol-text-dim/60"> → </span>
                  <span className="text-sol-blue">{pr.base_ref}</span>
                </>
              )}
            </span>
          )}
          <DiffStat additions={pr.additions} deletions={pr.deletions} files={pr.changed_files} className="ml-auto" />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-sol-border/40">
        <span className="text-meta text-sol-text-dim font-mono truncate">{repoObjectRefOf("pr", pr)}</span>
        {showOpen && (
          <span className="text-meta text-sol-text-dim inline-flex items-center gap-0.5 flex-shrink-0">
            Open <ArrowUpRight className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
      </Link>
    </div>
  );
}

// A pull request or commit codecast holds no row for: the reference itself
// (number or sha, repository), whether the lookup is still running or came
// back empty, and why it can be empty. The band below the content offers
// GitHub, which always has the object.
export function RepoObjectUnknownHoverContent({ rawId, served }: { rawId: string; served: boolean }) {
  const ref = parseRepoObjectId(rawId);
  const Icon = ref?.type === "commit" ? GitCommitHorizontal : GitPullRequest;
  const name = ref ? (ref.type === "pr" ? `#${ref.number}` : ref.sha.slice(0, 7)) : rawId;
  const what = ref?.type === "commit" ? "commit" : "pull request";
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{name}</div>
          {ref && <div className="mt-1 text-meta font-mono text-sol-text-muted truncate">{ref.repository}</div>}
        </div>
      </div>
      <p className="text-meta text-sol-text-muted leading-relaxed pl-[22px]">
        {served
          ? `Not in codecast. This ${what} is in a repository the GitHub App is not installed on, or it has not synced yet.`
          : `Looking this ${what} up…`}
      </p>
    </div>
  );
}

// A commit reference answers: its subject, who wrote it and when, the branch
// it landed on, where it stands in production when it is on main, and the
// body when the message has one.
export function CommitHoverContent({ commit, href, onOpen, production, showOpen }: { commit: any } & RepoCardLink) {
  const lines = String(commit.message ?? "").split("\n");
  const subject = lines[0]?.trim();
  const body = lines.slice(1).join("\n").trim();
  const when = relativeTime(commit.timestamp);
  return (
    <div className="space-y-2">
      <Link href={href} onClick={onOpen} className={CARD_LINK}>
      <div className="flex items-start gap-2">
        <GitCommitHorizontal className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-sol-yellow" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-sol-text leading-snug">{subject || commit.sha.slice(0, 7)}</div>
          <div className="flex items-center gap-2 mt-1 text-meta min-w-0">
            {commit.author_name && <span className="text-sol-text-muted truncate">{commit.author_name}</span>}
            {when && (
              <>
                <span className="text-sol-text-dim/60">·</span>
                <span className="text-sol-text-muted">{when}</span>
              </>
            )}
            {commit.branch && (
              <>
                <span className="text-sol-text-dim/60">·</span>
                <span className="text-sol-text-muted font-mono truncate">{commit.branch}</span>
              </>
            )}
          </div>
        </div>
      </div>
      </Link>
      {production}
      <Link href={href} onClick={onOpen} className={CARD_LINK}>
      {body && (
        <p className="text-meta text-sol-text-muted line-clamp-3 leading-relaxed pl-[22px] whitespace-pre-line">
          {body.slice(0, 220)}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-sol-border/40">
        <span className="text-meta text-sol-text-dim font-mono inline-flex items-center gap-2 min-w-0">
          <span className="truncate">{commit.repository ? `${commit.repository}@` : ""}{commit.sha.slice(0, 7)}</span>
          <DiffStat additions={commit.insertions} deletions={commit.deletions} files={commit.files_changed} />
        </span>
        {showOpen && (
          <span className="text-meta text-sol-text-dim inline-flex items-center gap-0.5 flex-shrink-0">
            Open <ArrowUpRight className="w-2.5 h-2.5" />
          </span>
        )}
      </div>
      </Link>
    </div>
  );
}
