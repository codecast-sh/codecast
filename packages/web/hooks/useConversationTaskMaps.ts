import { useMemo, useRef, useState } from "react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "../store/inboxStore";
import type { Message, TaskRecord } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";
import { ToolCallMemo, keepIfSameRecord } from "./toolCallMemo";

const api = _typedApi as any;

/**
 * Local task number → subject, from each TaskCreate call's input and the
 * "Task #N" its result reports. The subject parse is memoized per call, so a
 * streamed update parses only the TaskCreate calls it added or changed.
 */
export function taskSubjectMapOf(messages: readonly Message[], memo: ToolCallMemo<string | null>): Record<string, string> {
  memo.begin();
  const createInputs: Record<string, string> = {};
  const idMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.name === "TaskCreate") {
          const subject = memo.get(tc, (call) => {
            try {
              const inp = JSON.parse(call.input);
              return inp.subject ? String(inp.subject) : null;
            } catch {
              return null;
            }
          });
          if (subject !== null) createInputs[tc.id] = subject;
        }
      }
    }
    if (msg.tool_results) {
      for (const tr of msg.tool_results) {
        if (createInputs[tr.tool_use_id]) {
          const m = tr.content.match(/Task #(\d+)/);
          if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
        }
      }
    }
  }
  memo.end();
  return idMap;
}

export function useConversationTaskMaps({ conversation, deferredQueriesEnabled }: {
  conversation: ConversationData | null | undefined;
  deferredQueriesEnabled: boolean;
}) {
  // Same identity while the subjects are unchanged: every AssistantBlock takes
  // this map and the record map built from it as props.
  const [subjectMemo] = useState(() => new ToolCallMemo<string | null>());
  const taskSubjectMapRef = useRef<Record<string, string> | undefined>(undefined);
  const taskSubjectMap = useMemo(() => {
    const next = keepIfSameRecord(taskSubjectMapRef.current, taskSubjectMapOf(conversation?.messages ?? [], subjectMemo));
    taskSubjectMapRef.current = next;
    return next;
  }, [conversation?.messages, subjectMemo]);

  const conversationTasks = useQueryNoThrow(
    api.tasks.webListByConversation,
    deferredQueriesEnabled && conversation?._id && isConvexId(conversation._id) ? { conversationId: conversation._id } : "skip"
  ).data;

  const taskRecordMap = useMemo(() => {
    const byTitle: Record<string, TaskRecord> = {};
    const byLocalId: Record<string, TaskRecord> = {};
    if (conversationTasks) {
      for (const t of conversationTasks) {
        byTitle[t.title] = t;
      }
    }
    if (taskSubjectMap) {
      for (const [localId, title] of Object.entries(taskSubjectMap)) {
        if (byTitle[title]) byLocalId[localId] = byTitle[title];
      }
    }
    return { byTitle, byLocalId };
  }, [conversationTasks, taskSubjectMap]);

  return { taskSubjectMap, taskRecordMap };
}
