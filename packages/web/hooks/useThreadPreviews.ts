import { useCallback } from "react";
import { useTrackedStore, type InboxSession, type SessionDecisionItem, type TaskDetail } from "../store/inboxStore";
import type { ChatRailChannel } from "../store/chatSlice";
import type { PageThreadRow } from "../store/threadTypes";
import { isAgentComment, type Comment } from "../lib/commentThread";
import { cleanContent } from "../lib/conversationProcessor";
import { threadStateView } from "../lib/threadState";
import { replyPreview, summaryCount, type CardPreview, type ThreadCardModel } from "../lib/threadCards";
import { codeAnchorOf, rowOf, taskIdOf } from "../lib/threadRows";
import { useCodeComments } from "./useSyncCodeComments";
import type { CodeCommentRow } from "../lib/prView";
import { useThreadsPage } from "../components/threads/threadsContext";

// The Threads rows' second line, one hook per kind (lib/threadKinds binds
// them), and the store readers the kind renderers share with them. Hooks and
// helpers live here rather than beside the renderers so every component
// module exports only components (the Fast Refresh guard).

// ── Store readers ───────────────────────────────────────────────────────────

/** The task row, woken only by the fields a card shows. */
function taskSig(t: TaskDetail | undefined): string {
  if (!t) return "";
  const last = t.comments?.[t.comments.length - 1];
  return `${t.short_id}|${t.external?.identifier ?? ""}|${t.external?.synced_at ?? ""}|${t.external?.last_error ?? ""}|${t.title}|${t.status}|${t.priority ?? ""}|${t.assignee_info?.name ?? ""}|${t.plan?.short_id ?? ""}|${(t.description ?? "").length}|${t.comments?.length ?? 0}|${last?._id ?? ""}|${last?.text?.length ?? 0}`;
}

export function useTaskRow(taskId: string): TaskDetail | undefined {
  const s = useTrackedStore([(s) => taskSig(s.tasks[taskId] as TaskDetail | undefined)]);
  return s.tasks[taskId] as TaskDetail | undefined;
}

/** The page row, woken only by what a card shows. */
function pageSig(p: PageThreadRow | undefined): string {
  if (!p) return "";
  const last = p.comments[p.comments.length - 1];
  return `${p.title}|${p.slug}|${p.comments.length}|${last?._id ?? ""}|${last?.text.length ?? 0}`;
}

export function usePageThreadRow(artifactId: string): PageThreadRow | undefined {
  const s = useTrackedStore([(s: any) => pageSig(s.pageThreads[artifactId])]);
  return (s as any).pageThreads[artifactId] as PageThreadRow | undefined;
}

/** A code thread's rows, oldest first, from the store the commit page reads. */
export function useCodeThreadRows(card: ThreadCardModel): CodeCommentRow[] {
  const { repository, ref, filePath, lineNumber } = codeAnchorOf(rowOf(card));
  return useCodeComments(
    useCallback(
      (c: CodeCommentRow) =>
        c.repository === repository &&
        c.ref === ref &&
        (c.file_path ?? undefined) === filePath &&
        (c.line_number ?? undefined) === lineNumber,
      [repository, ref, filePath, lineNumber],
    ),
  );
}

const EMPTY_COMMENTS: Comment[] = [];

/** A session comment thread's rows, oldest first — from the page's ONE
 *  assembled map (threadsContext.commentThreads), never a per-card scan of
 *  the whole comments collection. */
export function useCommentThreadRows(card: ThreadCardModel): Comment[] {
  const { commentThreads } = useThreadsPage();
  return commentThreads.get(rowOf(card).root_key) ?? EMPTY_COMMENTS;
}

// ── Previews ────────────────────────────────────────────────────────────────

export function useTaskPreview(card: ThreadCardModel): CardPreview | null {
  return replyPreview(rowOf(card).last_reply);
}

export function useChatPreview(card: ThreadCardModel): CardPreview | null {
  const { nameOf } = useThreadsPage();
  return replyPreview(rowOf(card).last_reply, nameOf);
}

/** The rail carries the room's last line, already attributed. */
export function useDmPreview(card: ThreadCardModel): CardPreview | null {
  const channel = card.source as ChatRailChannel;
  if (channel.knownEmpty) return { text: "No messages yet" };
  return channel.lastMessagePreview ? { text: channel.lastMessagePreview } : null;
}

/** The newest reply; a thread with only its root previews the root. */
export function useCommentPreview(card: ThreadCardModel): CardPreview | null {
  const comments = useCommentThreadRows(card);
  const { nameOf } = useThreadsPage();
  const reply = replyPreview(rowOf(card).last_reply, nameOf);
  if (reply) {
    if (reply.whoKind === "user" && !reply.who) reply.who = "Teammate";
    return reply;
  }
  const root = comments[0];
  if (!root) return null;
  const agent = isAgentComment(root);
  return {
    who: agent ? "Agent" : (root as any).user?.name ?? "Teammate",
    whoKind: agent ? "agent" : "user",
    text: cleanContent(root.content).replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

export function useCodePreview(card: ThreadCardModel): CardPreview | null {
  const comments = useCodeThreadRows(card);
  const reply = replyPreview(rowOf(card).last_reply);
  if (reply) {
    if (reply.whoKind === "user" && !reply.who) reply.who = "Teammate";
    return reply;
  }
  const root = comments[0];
  if (!root) return null;
  const agent = (root as any).author_kind === "agent";
  return {
    who: agent ? "Agent" : (root as any).author_name ?? (root as any).author_github_username ?? "Teammate",
    whoKind: agent ? "agent" : "user",
    text: String((root as any).content ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

export function usePagePreview(card: ThreadCardModel): CardPreview | null {
  const reply = replyPreview(rowOf(card).last_reply);
  if (reply && !reply.who) reply.who = "A viewer";
  return reply;
}

/** The session's pinned state line, else its idle summary or subtitle. */
export function useSessionPreview(card: ThreadCardModel): CardPreview | null {
  const session = card.source as InboxSession;
  const { now } = useThreadsPage();
  const state = threadStateView(session as any, session.message_count ?? 0, now);
  const text = state?.cardLine ?? session.idle_summary ?? session.subtitle ?? "";
  return text ? { text } : null;
}

/** The question, and what happens if nobody answers. */
export function useQuestionPreview(card: ThreadCardModel): CardPreview | null {
  const d = card.source as SessionDecisionItem;
  const tail = d.blocking
    ? "The session is parked on your answer."
    : d.default_option !== undefined && d.options[d.default_option]
      ? `Proceeding with “${d.options[d.default_option].label}” unless you say otherwise.`
      : summaryCount(d.options.length, "option");
  return { who: d.question, text: tail };
}
