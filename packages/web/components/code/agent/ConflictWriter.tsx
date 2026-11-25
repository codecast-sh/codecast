// Who wrote the disk change a dirty buffer is waiting to merge: "by <session>"
// on the conflict strip and the merge view's header. Absent when no single
// working session could be named (a wrong name is worse than none).

import { memo } from "react";
import { useAgentStore } from "../../../lib/code/agent/agentStore";
import { SessionMark } from "./SessionMark";

export const ConflictWriter = memo(function ConflictWriter({ bufferKey }: { bufferKey: string }) {
  const writer = useAgentStore((s) => s.conflictWriters[bufferKey] ?? null);
  if (!writer) return null;
  return (
    <span data-agent-conflict-writer={writer} className="flex min-w-0 items-center gap-1.5 text-sol-text-muted">
      <span className="text-sol-text-dim">by</span>
      <SessionMark id={writer} />
    </span>
  );
});
