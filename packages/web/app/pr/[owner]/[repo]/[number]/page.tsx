import { useCallback, useMemo, useState, type RefCallback } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { GitPullRequest, FileDiff, ListChecks, MessagesSquare } from "lucide-react";
import { AuthGuard } from "../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../components/DashboardLayout";
import { FileDiffLayout, type DiffFile, type FileLineThreads } from "../../../../../components/FileDiffLayout";
import { KeyCap } from "../../../../../components/KeyboardShortcutsHelp";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { Button } from "../../../../../components/ui/button";
import { PRChecks } from "../../../../../components/pr/PRChecks";
import { PRHeader } from "../../../../../components/pr/PRHeader";
import { PRLineThread } from "../../../../../components/pr/PRThread";
import { PRRail } from "../../../../../components/pr/PRRail";
import { PRTimeline } from "../../../../../components/pr/PRTimeline";
import { useCurrentUser } from "../../../../../hooks/useCurrentUser";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useLinkedSessions } from "../../../../../hooks/useLinkedSessions";
import { useQueryNoThrow } from "../../../../../hooks/useQueryNoThrow";
import { useSyncPRExternalEvents, useExternalEvents } from "../../../../../hooks/useSyncExternalEvents";
import { useCodeComments, useSyncPRCodeComments } from "../../../../../hooks/useSyncCodeComments";
import { useSyncPullRequest, usePullRequest } from "../../../../../hooks/useSyncTimeline";
import { useTitlebarHead } from "../../../../../hooks/useTitlebarHead";
import { useInboxStore } from "../../../../../store/inboxStore";
import {
  PR_STATE_META,
  buildPrTimeline,
  groupCommentsByFileLine,
  prStateKey,
  unresolvedThreadCount,
  type CodeCommentRow,
} from "../../../../../lib/prView";
import { accentVar } from "../../../../../lib/externalEvents";
import "../../../../../components/pr/pr.css";

// `api` is a proxy, so naming a function prod has not deployed yet still
// produces a reference; the call then fails and useQueryNoThrow reports it as
// an error instead of unmounting the page. That is what lets this page ship
// before its backend half is deployed.
const api = _api as any;

type Tab = "conversation" | "files" | "checks";

const TABS: { key: Tab; label: string; icon: typeof GitPullRequest; digit: string }[] = [
  { key: "conversation", label: "Conversation", icon: MessagesSquare, digit: "1" },
  { key: "files", label: "Files", icon: FileDiff, digit: "2" },
  { key: "checks", label: "Checks", icon: ListChecks, digit: "3" },
];

function PRNotFound({ repository, number }: { repository: string; number: number }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-sol-text-muted">
      <GitPullRequest className="w-10 h-10 mb-3 opacity-30" />
      <h2 className="text-base font-medium mb-1">Pull request not found</h2>
      <p className="text-[13px] mb-4">
        #{number} in <code className="font-mono text-sol-violet">{repository}</code> is not in this
        workspace.
      </p>
      <a
        href={`https://github.com/${repository}/pull/${number}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Button variant="outline">Open it on GitHub</Button>
      </a>
    </div>
  );
}

function PRContent({
  repository,
  number,
  headRef,
}: {
  repository: string;
  number: number;
  headRef: RefCallback<HTMLDivElement>;
}) {
  const router = useRouter();
  const { user, isAuthenticated } = useCurrentUser();

  // Local first: the row comes from the store, which the timeline may already
  // have filled. This feeder only refreshes it.
  const prFeed = useSyncPullRequest({ repository, number });
  const pr = usePullRequest(repository, number);
  const prId = pr?._id as string | undefined;

  useSyncPRExternalEvents(prId);
  useSyncPRCodeComments(prId);
  const events = useExternalEvents(useCallback((e: any) => e.pr_id === prId, [prId]));
  const comments = useCodeComments(useCallback((c: any) => c.pull_request_id === prId, [prId]));
  const reviewsQuery = useQueryNoThrow(
    api.reviews.getReviewsForPR,
    prId ? { pull_request_id: prId } : "skip",
  );
  const reviews = useMemo(() => (reviewsQuery.data as any[]) ?? [], [reviewsQuery.data]);

  const createComment = useMutation(api.codeComments.create);
  const resolveComment = useMutation(api.codeComments.resolve);
  const unresolveComment = useMutation(api.codeComments.unresolve);
  const setShepherd = useMutation(api.prShepherd.setShepherd);

  const [tab, setTab] = useState<Tab>("conversation");
  const [composing, setComposing] = useState<{ file: string; line: number } | null>(null);

  const sessions = useLinkedSessions(pr?.linked_session_ids ?? []);
  const sessionChoices = useMemo(
    () => sessions.map((s: any) => ({ id: s._id as string, title: (s.title as string) || "Untitled session" })),
    [sessions],
  );

  const timeline = useMemo(
    () => buildPrTimeline({ events: events as any[], reviews, comments }),
    [events, reviews, comments],
  );

  // file → line → thread, plus the line a composer is open on (an empty thread,
  // which is how DiffView is asked to open a row that has no comments yet).
  const threadsByFile = useMemo(() => {
    const grouped = groupCommentsByFileLine(comments);
    if (composing) {
      const byLine = new Map(grouped.get(composing.file) ?? []);
      if (!byLine.has(composing.line)) byLine.set(composing.line, []);
      grouped.set(composing.file, byLine);
    }
    return grouped;
  }, [comments, composing]);

  const post = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!pr) return;
      const clientId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Render it now; the server row carrying this client_id supersedes the
      // stub when listForPR echoes it back (the collection's altKey).
      useInboxStore.getState().syncRecord("codeComments", clientId, {
        _id: clientId,
        client_id: clientId,
        pull_request_id: pr._id,
        repository,
        content: fields.content,
        resolved: false,
        created_at: Date.now(),
        author_user_id: user?._id,
        author_kind: "user",
        ...fields,
      });
      await createComment({
        repository,
        ref: pr.head_sha,
        pull_request_id: pr._id,
        client_id: clientId,
        mirror: true,
        ...fields,
      });
    },
    [createComment, pr, repository, user?._id],
  );

  const setThreadResolved = useCallback(
    (thread: CodeCommentRow[], resolved: boolean) => {
      for (const comment of thread) {
        if (comment._id.startsWith("cc-")) continue;
        void (resolved ? resolveComment : unresolveComment)({ comment_id: comment._id });
      }
    },
    [resolveComment, unresolveComment],
  );

  const lineThreads: FileLineThreads = useMemo(
    () => ({
      threadsFor: (filename) => threadsByFile.get(filename),
      render: (filename, line, items) => (
        <PRLineThread
          comments={items as CodeCommentRow[]}
          authed={isAuthenticated}
          onReply={(content) =>
            post({
              file_path: filename,
              line_number: line,
              side: "RIGHT",
              content,
              parent_id: (items as CodeCommentRow[])[0]?._id,
            })
          }
          onResolve={(resolved) => setThreadResolved(items as CodeCommentRow[], resolved)}
          onClose={() => setComposing(null)}
        />
      ),
      onComment: (filename, line) => {
        if (line !== undefined) setComposing({ file: filename, line });
      },
    }),
    [threadsByFile, isAuthenticated, post, setThreadResolved],
  );

  // Tab shortcuts. Ignored while typing, so a comment can contain a digit.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const hit = TABS.find((t) => t.digit === e.key);
    if (hit) setTab(hit.key);
  });

  if (!pr) {
    if (!prFeed.ready && !prFeed.error) return <LoadingSkeleton />;
    return <PRNotFound repository={repository} number={number} />;
  }

  const files: DiffFile[] = (pr.files ?? []).map((f: any) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));

  const openComments = unresolvedThreadCount(comments) || (pr.unresolved_review_count ?? 0);

  return (
    <div
      className="pr-page h-full flex flex-col"
      style={{ ["--pr-accent" as string]: accentVar(PR_STATE_META[prStateKey(pr)].accent) }}
    >
      <div ref={headRef}>
        <PRHeader
          pr={pr}
          repository={repository}
          number={number}
          openComments={openComments}
          sessionChoices={sessionChoices}
          onSetShepherd={(conversationId, enabled) =>
            void setShepherd({ pr_id: pr._id, conversation_id: conversationId, enabled })
          }
        />
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <nav className="flex items-center gap-1 border-b border-sol-border/50 px-4 shrink-0">
            {TABS.map(({ key, label, icon: Icon, digit }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`group flex items-center gap-2 border-b-2 px-3 py-2 text-[12px] transition-colors ${
                  tab === key
                    ? "border-current text-sol-text"
                    : "border-transparent text-sol-text-muted hover:text-sol-text"
                }`}
                style={tab === key ? { color: "var(--pr-accent)" } : undefined}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
                {key === "files" && files.length > 0 && (
                  <span className="text-[11px] text-sol-text-dim">{files.length}</span>
                )}
                <span className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <KeyCap size="xs">{digit}</KeyCap>
                </span>
              </button>
            ))}
          </nav>

          <div className="flex-1 min-h-0">
            {tab === "conversation" && (
              <PRTimeline
                pr={pr}
                items={timeline}
                authed={isAuthenticated}
                onPostComment={(content) => post({ content })}
                onResolve={(commentId, resolved) => {
                  const target = comments.find((c) => c._id === commentId);
                  if (target) setThreadResolved([target], resolved);
                }}
                onNavigate={(path) => router.push(path)}
              />
            )}
            {tab === "files" &&
              (files.length === 0 ? (
                <div className="h-full flex items-center justify-center text-[13px] text-sol-text-dim">
                  No file changes have been synced for this pull request yet.
                </div>
              ) : (
                <FileDiffLayout files={files} lineThreads={lineThreads} />
              ))}
            {tab === "checks" && <PRChecks checks={pr.checks} />}
          </div>
        </div>

        <aside className="pr-rail w-[320px] shrink-0 border-l border-sol-border/50 bg-sol-bg-alt/20">
          <PRRail
            pr={pr}
            sessions={sessions}
            reviews={reviews}
            onOpenSession={(id) => router.push(`/conversation/${id}`)}
          />
        </aside>
      </div>
    </div>
  );
}

export default function PRPage() {
  const params = useParams();
  const headRef = useTitlebarHead<HTMLDivElement>();
  const owner = params.owner as string;
  const repo = params.repo as string;
  const number = parseInt(params.number as string, 10);

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-[calc(100vh-56px)]">
          <PRContent repository={`${owner}/${repo}`} number={number} headRef={headRef} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
