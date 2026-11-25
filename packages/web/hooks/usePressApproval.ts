// The judged files a session's change touches, each with the sessions that wrote it, listed beside a Ship button, and
// the click that approves exactly those (convex changeApprovals.recordPress, ct-100350): Ship's confirm in the header
// and the one-click list in the thread after a person types "ship" both read it.
import { useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { sessionRootOf } from "./useRepoFlows";
import { judgedList, type JudgedFile } from "../lib/ship/judgedEdits";

type TitleRow = { title?: string | null };
const SEP = "\u0000";

/** Null files: the repository is not opted in, nothing is listed. Reads nothing while `active` is false. */
export function usePressApproval(conversationId: string, active: boolean): { files: JudgedFile[] | null; record: () => Promise<boolean> } {
  // Read only while shown: the header holds this hook and must cost nothing the rest of the time.
  const root = useInboxStore((s) => (active ? sessionRootOf(s as any, conversationId) : null));
  // What codecast knows the change touches: its pull request's judged diff and its checkout's uncommitted judged files.
  const { data: change } = useQueryNoThrow(api.changeApprovals.shipList, active ? { conversation_id: conversationId as any } : "skip");
  const msgs = useInboxStore((s) => (active ? (s.messages as Record<string, Array<{ tool_calls?: Array<{ name?: string; input?: string }> }>>)[conversationId] : undefined));
  const listed = useMemo(() => judgedList(msgs ?? [], root, conversationId, change ?? null), [msgs, root, conversationId, change]);
  // Writers by their titles in this viewer's store: a team row never carries a private session's title.
  const ids = useMemo(() => [...new Set((listed ?? []).flatMap((f) => f.writers))], [listed]);
  const titles = useInboxStore((s) => ids.map((id) => (((s.sessions as Record<string, TitleRow>)[id] ?? (s.conversations as Record<string, TitleRow>)[id])?.title ?? "").trim()).join(SEP));
  const files = useMemo(() => {
    if (!listed) return null;
    const named = titles.split(SEP);
    const titleOf = new Map(ids.map((id, i) => [id, named[i] || "another session"]));
    return listed.map((f) => ({ ...f, writers: f.writers.map((id) => titleOf.get(id)!) }));
  }, [listed, ids, titles]);
  const recordPress = useMutation(api.changeApprovals.recordPress);
  const record = async () => {
    if (!files) return false;
    try {
      await recordPress({ conversation_id: conversationId as any, files: files.map((f) => f.path) });
      return true;
    } catch (err) {
      console.warn("[ship] the click was not recorded as an approval:", err);
      return false;
    }
  };
  return { files, record };
}
