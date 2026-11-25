// The judged files a session edited, listed beside a Ship button, and the click that approves exactly those
// (convex changeApprovals.recordPress, ct-100350): Ship's confirm in the header and the one-click list in the thread
// after a person types "ship" both read it.
import { useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { repositoryOfRemote, sessionRemoteOf, sessionRootOf } from "./useRepoFlows";
import { judgedEdits } from "../lib/ship/judgedEdits";

/** Null files: the repository is not opted in, nothing is listed. Reads nothing while `active` is false. */
export function usePressApproval(conversationId: string, active: boolean): { files: string[] | null; record: () => Promise<boolean> } {
  // Read only while shown: the header holds this hook and must cost nothing the rest of the time.
  const remote = useInboxStore((s) => (active ? sessionRemoteOf(s as any, conversationId) : null));
  const root = useInboxStore((s) => (active ? sessionRootOf(s as any, conversationId) : null));
  const repository = repositoryOfRemote(remote);
  const { data: judges } = useQueryNoThrow(api.changeApprovals.judgesFor, active && repository ? { repository } : "skip");
  const msgs = useInboxStore((s) => (active ? (s.messages as Record<string, Array<{ tool_calls?: Array<{ name?: string; input?: string }> }>>)[conversationId] : undefined));
  const files = useMemo(() => judgedEdits(msgs ?? [], root, judges), [msgs, root, judges]);
  const recordPress = useMutation(api.changeApprovals.recordPress);
  const record = async () => {
    if (!files) return false;
    try {
      await recordPress({ conversation_id: conversationId as any, files });
      return true;
    } catch (err) {
      console.warn("[ship] the click was not recorded as an approval:", err);
      return false;
    }
  };
  return { files, record };
}
