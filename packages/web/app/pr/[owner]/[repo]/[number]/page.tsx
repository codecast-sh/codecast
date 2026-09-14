import { useCallback, useMemo, useRef, useState, type RefCallback } from "react";
import { useAction, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { codeThreadRootKey } from "@codecast/shared/comments";
import { repoObjectGitHubUrl } from "@codecast/shared/entities";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { GitPullRequest, FileDiff, GitCommitHorizontal, ListChecks, MessagesSquare } from "lucide-react";
import { RepoPageShell } from "../../../../../components/repo/RepoPageShell";
import { FileDiffLayout, type DiffFile, type FileLineThreads } from "../../../../../components/FileDiffLayout";
import { KeyCap } from "../../../../../components/KeyboardShortcutsHelp";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { Button } from "../../../../../components/ui/button";
import { PRChecks } from "../../../../../components/pr/PRChecks";
import { PRCommits } from "../../../../../components/pr/PRCommits";
import { PRHeader } from "../../../../../components/pr/PRHeader";
import { MergeMenu, MoreMenu, ReviewMenu } from "../../../../../components/pr/PRActions";
import { PRLineThread, type NoteMode } from "../../../../../components/pr/PRThread";
import { PRRail } from "../../../../../components/pr/PRRail";
import { PRTimeline } from "../../../../../components/pr/PRTimeline";
import { useCurrentUser } from "../../../../../hooks/useCurrentUser";
import { useEventListener } from "../../../../../hooks/useEventListener";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
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
  commentAnchor,
  fileThreadMarks,
  groupCommentsByFileLine,
  isOptimisticComment,
  newCommentClientId,
  pendingNotes,
  prStateKey,
  serverCommentId,
  threadSide,
  threadStops,
  unresolvedThreadCount,
  type CodeCommentRow,
} from "../../../../../lib/prView";
import { diffLineKey, type DiffLineAnchor } from "../../../../../lib/patchParser";
import { accentVar } from "../../../../../lib/externalEvents";
import "../../../../../components/pr/pr.css";

// `api` is a proxy, so naming a function prod has not deployed yet still
// produces a reference; the call then fails and useQueryNoThrow reports it as
// an error instead of unmounting the page. That is what lets this page ship
// before its backend half is deployed.
const api = _api as any;

type Tab = "conversation" | "files" | "commits" | "checks";

const TABS: { key: Tab; label: string; icon: typeof GitPullRequest; digit: string }[] = [
  { key: "conversation", label: "Conversation", icon: MessagesSquare, digit: "1" },
  { key: "files", label: "Files", icon: FileDiff, digit: "2" },
  { key: "commits", label: "Commits", icon: GitCommitHorizontal, digit: "3" },
  { key: "checks", label: "Checks", icon: ListChecks, digit: "4" },
];

const NOTE_MODE_KEY = "pr.noteMode";

function PRNotFound({ repository, number }: { repository: string; number: number }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-sol-text-muted">
      <GitPullRequest className="w-10 h-10 mb-3 opacity-30" />
      <h2 className="text-base font-medium mb-1">Pull request not found</h2>
      <p className="text-[13px] mb-2">
        #{number} in <code className="font-mono text-sol-violet">{repository}</code> is not in this
        workspace.
      </p>
      <p className="text-[12px] mb-4 max-w-md text-center leading-relaxed">
        A repository is here once the GitHub App is installed on{" "}
        <code className="font-mono">{repository.split("/")[0]}</code> for one of your teams.{" "}
        <Link href="/settings/integrations" className="text-sol-cyan hover:underline">
          Open integrations
        </Link>{" "}
        to install it there, or to add this repository to an install that exists.
      </p>
      <a
        href={repoObjectGitHubUrl({ type: "pr", repository, number })}
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

  // A pull request the install's backfill window did not reach (an old closed
  // one) is asked from GitHub once, through the team's install; the store row
  // then arrives on the feed above. Only after that ask has answered does the
  // page say "not found".
  const fetchPull = useAction(api.githubApp.fetchPull);
  const [lookup, setLookup] = useState<"idle" | "pending" | "done">("idle");
  useWatchEffect(() => {
    if (pr || lookup !== "idle" || !prFeed.ready || !isAuthenticated) return;
    setLookup("pending");
    void fetchPull({ repository, number }).catch(() => null).finally(() => setLookup("done"));
  }, [pr, lookup, prFeed.ready, isAuthenticated, repository, number]);

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
  const [composing, setComposing] = useState<{ file: string; anchor: DiffLineAnchor } | null>(null);

  // The review: where a new note goes (held, or out at once), remembered on
  // this device; the notes waiting; and the menu that sends them.
  const [noteMode, setNoteModeState] = useState<NoteMode>(() =>
    (typeof localStorage !== "undefined" && (localStorage.getItem(NOTE_MODE_KEY) as NoteMode)) || "review");
  const setNoteMode = useCallback((mode: NoteMode) => {
    setNoteModeState(mode);
    localStorage.setItem(NOTE_MODE_KEY, mode);
  }, []);
  const [reviewOpen, setReviewOpen] = useState(false);
  const notes = useMemo(() => pendingNotes(comments), [comments]);

  // Viewed files: the reader's own mark, synced with the rest of their prefs.
  const viewedFiles = useInboxStore((s) => (prId ? s.clientState.ui?.pr_viewed_files?.[prId] : undefined));
  const viewedSet = useMemo(() => new Set(viewedFiles ?? []), [viewedFiles]);
  const toggleViewed = useCallback((filename: string) => {
    if (!prId) return;
    const all = useInboxStore.getState().clientState.ui?.pr_viewed_files ?? {};
    const current = new Set(all[prId] ?? []);
    if (current.has(filename)) current.delete(filename);
    else current.add(filename);
    useInboxStore.getState().updateClientUI({ pr_viewed_files: { ...all, [prId]: [...current] } });
  }, [prId]);

  // Walking the threads: n and p move through the open ones in file order;
  // a jump from the timeline or the review menu lands on one directly.
  const [landing, setLanding] = useState<{ file: string; key: string; nonce: number } | null>(null);
  const jumpTo = useCallback((file: string, key: string) => {
    setTab("files");
    setLanding({ file, key, nonce: Date.now() });
  }, []);
  const jumpToComment = useCallback((comment: CodeCommentRow) => {
    if (!comment.file_path || comment.line_number === undefined) return;
    jumpTo(comment.file_path, diffLineKey(commentAnchor(comment)));
  }, [jumpTo]);
  useWatchEffect(() => {
    if (!landing) return;
    let tries = 0;
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-pr-thread="${CSS.escape(`${landing.file}|${landing.key}`)}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (tries++ < 20) requestAnimationFrame(find);
    };
    requestAnimationFrame(find);
  }, [landing]);

  const sessions = useLinkedSessions(pr?.linked_session_ids ?? []);
  const sessionChoices = useMemo(
    () => sessions.map((s: any) => ({ id: s._id as string, title: (s.title as string) || "Untitled session" })),
    [sessions],
  );

  const timeline = useMemo(
    () => buildPrTimeline({ events: events as any[], reviews, comments }),
    [events, reviews, comments],
  );

  // file → anchor → thread, plus the anchor a composer is open on (an empty
  // thread, which is how DiffView is asked to open a row with no comments yet).
  const threadsByFile = useMemo(() => {
    const grouped = groupCommentsByFileLine(comments);
    if (composing) {
      const key = diffLineKey(composing.anchor);
      const byLine = new Map(grouped.get(composing.file) ?? []);
      if (!byLine.has(key)) byLine.set(key, []);
      grouped.set(composing.file, byLine);
    }
    return grouped;
  }, [comments, composing]);

  const post = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!pr) return;
      const clientId = newCommentClientId();
      // A fresh note on a line joins the review when the reader has asked for
      // that; a reply, or a comment on the conversation, is said at once.
      const pending = noteMode === "review" && !!fields.file_path && !fields.parent_id;
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
        pending_review: pending || undefined,
        ...fields,
      });
      await createComment({
        repository,
        ref: pr.head_sha,
        pull_request_id: pr._id,
        client_id: clientId,
        mirror: !pending,
        pending,
        ...fields,
      });
    },
    [createComment, noteMode, pr, repository, user?._id],
  );

  const setThreadResolved = useCallback(
    (thread: CodeCommentRow[], resolved: boolean) => {
      for (const comment of thread) {
        if (isOptimisticComment(comment._id)) continue;
        void (resolved ? resolveComment : unresolveComment)({ comment_id: comment._id });
      }
    },
    [resolveComment, unresolveComment],
  );

  const lineThreads: FileLineThreads = useMemo(
    () => ({
      threadsFor: (filename) => threadsByFile.get(filename),
      render: (filename, anchor, items) => (
        <div data-pr-thread={`${filename}|${diffLineKey(anchor)}`}>
        <PRLineThread
          repository={repository}
          threadKey={codeThreadRootKey(repository, pr?.head_sha ?? "", { file_path: filename, line_number: anchor.lineNumber })}
          comments={items as CodeCommentRow[]}
          authed={isAuthenticated}
          lineNumber={anchor.lineNumber}
          lineEnd={anchor.lineEnd}
          noteMode={noteMode}
          onNoteMode={setNoteMode}
          pendingCount={notes.length}
          landed={!!landing && landing.file === filename && landing.key === diffLineKey(anchor)}
          onReply={(content) =>
            post({
              file_path: filename,
              // The anchor is the first line either way; line_end is set only
              // when the comment covers a run, which is what GitHub expects.
              line_number: anchor.lineNumber,
              line_end: anchor.lineEnd,
              // A reply belongs on the side its thread sits on; an empty thread
              // is the composer the hover handle just opened, so take the side
              // of the row it opened on.
              side: items.length ? threadSide(items as CodeCommentRow[]) : anchor.side,
              content,
              // A reply sent before the root's server row lands would carry a
              // stub id the validator rejects; post it unparented instead.
              parent_id: serverCommentId((items as CodeCommentRow[])[0]?._id),
            })
          }
          onResolve={(resolved) => setThreadResolved(items as CodeCommentRow[], resolved)}
          onClose={() => setComposing(null)}
        />
        </div>
      ),
      onComment: (filename, anchor) => {
        if (anchor) setComposing({ file: filename, anchor });
      },
    }),
    [threadsByFile, isAuthenticated, post, setThreadResolved, repository, pr?.head_sha, noteMode, setNoteMode, notes.length, landing],
  );

  // What the tree shows beside each file: open threads, waiting notes, viewed.
  const threadMarks = useMemo(() => fileThreadMarks(comments), [comments]);
  const fileMarks = useCallback(
    (filename: string) => {
      const marks = threadMarks.get(filename);
      const viewed = viewedSet.has(filename);
      if (!marks && !viewed) return undefined;
      return { open: marks?.open, pending: marks?.pending, viewed };
    },
    [threadMarks, viewedSet],
  );

  // Tab shortcuts. Ignored while typing, so a comment can contain a digit, and
  // ignored when this copy of the page is off screen: a background tab keeps
  // its pane mounted under `display: none`, and both copies would otherwise
  // answer the same keypress. offsetParent is null exactly then.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!rootRef.current?.offsetParent) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const hit = TABS.find((t) => t.digit === e.key);
    if (hit) { setTab(hit.key); return; }
    if (e.key === "r" && isAuthenticated) { e.preventDefault(); setReviewOpen((v) => !v); return; }
    if (e.key === "n" || e.key === "p") {
      const stops = threadStops(pr?.files ?? [], comments).filter((s) => s.open);
      if (stops.length === 0) return;
      e.preventDefault();
      const at = landing ? stops.findIndex((s) => s.file === landing.file && s.key === landing.key) : -1;
      const next = e.key === "n"
        ? stops[(at + 1) % stops.length]
        : stops[(at - 1 + stops.length) % stops.length];
      jumpTo(next.file, next.key);
    }
  });

  if (!pr) {
    if ((!prFeed.ready && !prFeed.error) || lookup !== "done") return <LoadingSkeleton />;
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
      ref={rootRef}
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
          actions={isAuthenticated && (
            <>
              <ReviewMenu
                pr={pr}
                notes={notes}
                authorLogin={user?.github_username}
                onNavigate={jumpToComment}
                open={reviewOpen}
                onOpenChange={setReviewOpen}
                sessionChoices={sessionChoices}
              />
              <MergeMenu pr={pr} />
              <MoreMenu pr={pr} />
            </>
          )}
        />
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <nav
            role="tablist"
            aria-label="Pull request views"
            className="flex items-center gap-1 border-b border-sol-border/50 px-4 shrink-0"
          >
            {TABS.map(({ key, label, icon: Icon, digit }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
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
                {key === "files" && notes.length > 0 && (
                  <span className="rounded-full border border-dashed border-sol-yellow/60 px-1.5 text-[10px] text-sol-yellow" title="Notes in your review">
                    {notes.length}
                  </span>
                )}
                {key === "commits" && (pr.commits?.length ?? 0) > 0 && (
                  <span className="text-[11px] text-sol-text-dim">{pr.commits.length}</span>
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
                comments={comments}
                onJumpToThread={jumpToComment}
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
                <FileDiffLayout
                  files={files}
                  lineThreads={lineThreads}
                  fileMarks={fileMarks}
                  onToggleViewed={isAuthenticated ? toggleViewed : undefined}
                  focusFile={landing?.file ?? null}
                />
              ))}
            {tab === "commits" && <PRCommits repository={repository} commits={pr.commits} />}
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
  const number = Number(params.number);

  return (
    <RepoPageShell repository={`${owner}/${repo}`}>
      <PRContent repository={`${owner}/${repo}`} number={number} headRef={headRef} />
    </RepoPageShell>
  );
}
