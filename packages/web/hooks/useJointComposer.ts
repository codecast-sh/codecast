import { useRef } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import type { PresenceRow } from "./useDocPresence";
import { composeDocId } from "../lib/composerPresence";
import { formatJointMessage } from "@codecast/shared/contracts/jointMessage";
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
    claim({ doc_id: docId, claims: sent.map((c) => ({ user_id: c.user_id as Id<"users">, text: c.text, how: "joint" })) }).catch(() => {});
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
        toast(claimNotice(row.user_name, c.how), { description: rest ? "What you typed after it is still here." : undefined });
      }
    }
  }, [claimSig, myId]);

  return { candidates, claimSent };
}

/**
 * Taking a suggestion (a draft from someone who may not send into the
 * session, shown as a ghost): into my composer, appended to what I have, or
 * straight into the session as their words in their name, which queues it
 * behind the agent's turn like any send. Either way their composer clears
 * through the same claim a joint send writes.
 */
export function useAcceptSuggestion(conversationId: string, populate: (text: string, opts?: { append?: boolean }) => void) {
  const claim = useMutation(api.docSync.claimDrafts);
  return (row: PresenceRow, into: "composer" | "session") => {
    const text = row.draft_text?.trim();
    if (!text) return;
    if (into === "composer") populate(text, { append: true });
    else {
      const st = useInboxStore.getState();
      const content = formatJointMessage([{ from: row.user_name, body: text }]);
      const clientId = st.addOptimisticMessage(conversationId, content);
      st.sendMessageWhenReady(conversationId, content, undefined, clientId);
    }
    claim({ doc_id: composeDocId(conversationId), claims: [{ user_id: row.user_id as Id<"users">, text, how: into }] }).catch(() => {});
  };
}

/** What the author of a taken draft is told. */
export function claimNotice(by: string, how: string | undefined): string {
  if (how === "composer") return `${by} took your suggestion into their draft`;
  if (how === "session") return `${by} sent your suggestion to the session`;
  return `${by} sent your draft together with theirs`;
}
