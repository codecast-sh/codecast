import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "../store/inboxStore";
import type { TaskRecord } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";

const api = _typedApi as any;

export function useConversationTaskMaps({ conversation, deferredQueriesEnabled }: {
  conversation: ConversationData | null | undefined;
  deferredQueriesEnabled: boolean;
}) {
  const taskSubjectMap = useMemo(() => {
    const createInputs: Record<string, string> = {};
    const idMap: Record<string, string> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "TaskCreate") {
              try {
                const inp = JSON.parse(tc.input);
                if (inp.subject) createInputs[tc.id] = String(inp.subject);
              } catch {}
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
    }
    return idMap;
  }, [conversation?.messages]);

  const conversationTasks = useQuery(
    api.tasks.webListByConversation,
    deferredQueriesEnabled && conversation?._id && isConvexId(conversation._id) ? { conversationId: conversation._id } : "skip"
  );

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
