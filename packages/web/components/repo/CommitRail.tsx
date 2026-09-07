// What was said about a commit.
//
// Two lists. The discussion is every thread on the commit itself, oldest
// first, with a composer at the foot for a new one. Below it, an index of the
// threads on lines of the diff, one row per thread, so a reader sees at a
// glance where the conversation is and jumps to it. Both read the same
// comments the diff reads; the rail only arranges them.
import { useMemo } from "react";
import { CheckCircle2, FileCode2, MessageSquare } from "lucide-react";
import { codeThreadRootKey } from "@codecast/shared/comments";
import { PRComposer, PRLineThread } from "../pr/PRThread";
import type { LineComments } from "../../hooks/useLineComments";
import {
  groupCommentsByFileLine,
  prComments,
  serverCommentId,
  threadResolved,
  type CodeCommentRow,
} from "../../lib/prView";
import { parseDiffLineKey } from "../../lib/patchParser";
import { cn } from "../../lib/utils";

/** One thread on the commit itself: a root and its replies. */
function commitThreads(comments: CodeCommentRow[]): CodeCommentRow[][] {
  const roots = prComments(comments);
  const replies = comments.filter((c) => !c.file_path && c.parent_id);
  return roots.map((root) => [
    root,
    ...replies
      .filter((r) => r.parent_id === root._id)
      .sort((a, b) => a.created_at - b.created_at),
  ]);
}

export function CommitRail({
  repository,
  sha,
  comments,
  lineComments,
  pullRequestId,
  onJump,
}: {
  repository: string;
  sha: string;
  comments: CodeCommentRow[];
  lineComments: LineComments;
  /** The open pull request the commit belongs to, so a comment mirrors there. */
  pullRequestId?: string;
  /** Show this file's thread in the diff. */
  onJump: (filePath: string, lineNumber?: number) => void;
}) {
  const threads = useMemo(() => commitThreads(comments), [comments]);
  const lineIndex = useMemo(() => {
    const out: { file: string; line: number; count: number; resolved: boolean; first: number }[] = [];
    for (const [file, byLine] of groupCommentsByFileLine(comments)) {
      for (const [key, thread] of byLine) {
        if (!thread.length) continue;
        out.push({
          file,
          line: parseDiffLineKey(key).lineNumber,
          count: thread.length,
          resolved: threadResolved(thread),
          first: thread[0].created_at,
        });
      }
    }
    return out.sort((a, b) => a.first - b.first);
  }, [comments]);
  const prField = pullRequestId ? { pull_request_id: pullRequestId } : {};
  const generalKey = codeThreadRootKey(repository, sha, {});

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="px-4 pt-3 pb-4">
          <h2 className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sol-text-dim mb-2">
            <MessageSquare className="w-3 h-3" />
            Discussion
            {threads.length > 0 && <span className="text-sol-text-dim/70">{threads.length}</span>}
          </h2>
          {threads.length === 0 ? (
            <p className="text-[12px] text-sol-text-dim leading-relaxed">
              Nothing yet. Name a teammate with @ or a session with @[ and they hear about it.
            </p>
          ) : (
            <div className="space-y-3">
              {threads.map((thread) => (
                <div key={thread[0]._id} id={`comment-${thread[0]._id}`} className="-ml-2">
                  <PRLineThread
                    repository={repository}
                    threadKey={generalKey}
                    comments={thread}
                    authed={lineComments.authed}
                    onReply={(content) =>
                      lineComments.post({
                        content,
                        parent_id: serverCommentId(thread[0]._id),
                        ...prField,
                      })
                    }
                    onResolve={(resolved) => lineComments.setThreadResolved(thread, resolved)}
                    onClose={() => {}}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {lineIndex.length > 0 && (
          <section className="px-4 pb-4 border-t border-sol-border/40 pt-3">
            <h2 className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-sol-text-dim mb-2">
              <FileCode2 className="w-3 h-3" />
              On lines
              <span className="text-sol-text-dim/70">{lineIndex.length}</span>
            </h2>
            <ul className="space-y-0.5">
              {lineIndex.map((t) => (
                <li key={`${t.file}:${t.line}`}>
                  <button
                    type="button"
                    onClick={() => onJump(t.file, t.line)}
                    className={cn(
                      "w-full flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-sol-bg-alt/60",
                      t.resolved ? "text-sol-text-dim" : "text-sol-text-muted",
                    )}
                    title={t.file}
                  >
                    {t.resolved ? (
                      <CheckCircle2 className="w-3 h-3 shrink-0 text-sol-green/70" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-sol-cyan ml-[3px] mr-[3px]" />
                    )}
                    <span className="font-mono truncate">
                      <span className="text-sol-text-dim">{t.file.split("/").slice(0, -1).join("/")}{t.file.includes("/") ? "/" : ""}</span>
                      {t.file.split("/").pop()}
                      <span className="text-sol-text-dim">:{t.line}</span>
                    </span>
                    <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums shrink-0">{t.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {lineComments.authed && (
        <div className="border-t border-sol-border/50 px-3 py-2.5 shrink-0">
          <PRComposer
            repository={repository}
            threadKey={generalKey}
            placeholder="Comment on this commit"
            onSubmit={(content) => lineComments.post({ content, ...prField })}
          />
        </div>
      )}
    </div>
  );
}
