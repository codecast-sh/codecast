import { useMemo } from "react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { shareTokenArg } from "../lib/shareTokenScope";
import { isConvexId } from "../store/inboxStore";
import { useDiffViewerStore, type FileChangeEntry } from "../store/diffViewerStore";

// Bytes one request asks for, by the sizes the index carries. Under the
// server's own budget (fileChangeBodies.FILE_CHANGE_BODY_BUDGET) so a batch
// normally comes back whole; when the server still truncates, the rest is
// simply the next batch.
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_KEYS = 200;

/**
 * Fill the diff viewer's body cache for `needed` (the changes a fold reads,
 * shared/diff selectFoldInputs), one batch at a time: each answer lands in the
 * store, the next render asks for what is still missing, and the loop ends
 * when nothing is. Changes the server cannot answer for are marked missing
 * so they never block the batch after them.
 */
export function useFileChangeBodies(conversationId: string | undefined, needed: FileChangeEntry[]): void {
  const bodies = useDiffViewerStore((s) => s.bodies);
  const missingBodies = useDiffViewerStore((s) => s.missingBodies);
  const addBodies = useDiffViewerStore((s) => s.addBodies);

  const batch = useMemo(() => {
    const keys: string[] = [];
    let bytes = 0;
    for (const change of needed) {
      if (change.newContent !== undefined || bodies[change.id] || missingBodies[change.id]) continue;
      const size = (change.oldBytes ?? 0) + (change.newBytes ?? 0);
      if (keys.length > 0 && bytes + size > BATCH_BYTES) break;
      keys.push(change.id);
      bytes += size;
      if (keys.length >= BATCH_KEYS) break;
    }
    return keys;
  }, [needed, bodies, missingBodies]);

  const live = conversationId && isConvexId(conversationId) && batch.length > 0;
  const { data } = useQueryNoThrow(
    api.messages.getFileChangeBodies,
    live
      ? { conversation_id: conversationId as Id<"conversations">, ...shareTokenArg(conversationId), change_keys: batch }
      : "skip",
  );

  useWatchEffect(() => {
    if (!data || !conversationId) return;
    const answered = new Set(data.bodies.map((b) => b.id));
    // A truncated answer stops at the budget: the keys after its last body
    // are not missing, they are the next batch.
    let lastAnswered = batch.length - 1;
    if (data.truncated) while (lastAnswered >= 0 && !answered.has(batch[lastAnswered])) lastAnswered--;
    const missing = batch.slice(0, lastAnswered + 1).filter((key) => !answered.has(key));
    addBodies(conversationId, data.bodies, missing);
  }, [data]);
}
