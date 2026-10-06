import { useRef } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import type { PresenceRow } from "./useDocPresence";
import { composeDocId } from "../lib/composerPresence";
import { draftAfterClaim, jointCandidatesOf, setJointCandidates, type JointCandidate } from "../lib/jointSend";

/**
 * Both halves of "send together" for one composer in a session.
 *
 * Sending: publishes others' live drafts as this composer's joint candidates,
 * and when a joint turn goes out, writes the claims (docSync.claimDrafts) that
 * tell each named author their words were sent.
 *
 * Receiving: watches the claims on others' presence rows for one naming me,
 * and takes the sent words out of my draft (`applyDraft` with what is left),
 * saying who sent them. A draft I rewrote since is left alone.
 */
export function useJointComposer(opts: {
  conversationId: string;
  present: readonly PresenceRow[];
  me: string;
  draft: string;
  applyDraft: (rest: string) => void;
}): { candidates: JointCandidate[]; claimSent: (sent: JointCandidate[]) => void } {
  const { conversationId, present, me, draft, applyDraft } = opts;
  const claim = useMutation(api.docSync.claimDrafts);
  const myId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const docId = composeDocId(conversationId);

  const candidates = jointCandidatesOf(present);
  const sig = candidates.map((c) => `${c.user_id}:${c.text}`).join("\u0001");
  const claimSent = (sent: JointCandidate[]) => {
    claim({ doc_id: docId, claims: sent.map((c) => ({ user_id: c.user_id as Id<"users">, text: c.text })) }).catch(() => {});
  };
  useWatchEffect(() => {
    setJointCandidates(conversationId, me, candidates, claimSent);
    return () => setJointCandidates(conversationId, me, [], () => {});
  }, [conversationId, me, sig]);

  const handledRef = useRef(new Set<string>());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const claimSig = present.map((p) => (p.claims ?? []).map((c) => `${c.user_id}@${c.at}`).join(",")).join("|");
  useWatchEffect(() => {
    if (!myId) return;
    for (const row of present) {
      for (const c of row.claims ?? []) {
        const key = `${row.user_id}@${c.at}`;
        if (c.user_id !== myId || handledRef.current.has(key)) continue;
        handledRef.current.add(key);
        const rest = draftAfterClaim(draftRef.current, c.text);
        if (rest === null) continue;
        applyDraft(rest);
        toast(`${row.user_name} sent your draft together with theirs`, { description: rest ? "What you typed after it is still here." : undefined });
      }
    }
  }, [claimSig, myId]);

  return { candidates, claimSent };
}
