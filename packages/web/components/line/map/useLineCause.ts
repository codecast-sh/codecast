// Filing and starting a change to the line (line-map.md LX6), for every
// surface that asks for one: the Change composer on a map panel, and "Send
// through the line" on a station's prompt. The store paints the cause at
// once (lineSlice.fileLineCause); a refusal takes the painted row back and
// says why in place.
import { useCallback, useMemo, useState } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../store/mutativeMiddleware";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import type { LineCauseFields } from "../../../lib/line/lineCause";

export type LineCauseRow = { key: string; id: string | null; shortId: string | null; title: string; status: string; running: boolean };

const newClientKey = () => `lc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it";

/**
 * The causes filed against one node: the ones this panel filed, and the open
 * ones the store's signals name with the node as subject. Read through a
 * string signature so the panel re-renders only when one of them changes.
 */
export function useLineCauses(projectId: string | null, subject: string, keys: string[]): LineCauseRow[] {
  const sig = useInboxStore((s) => {
    const tasks = (s.tasks ?? {}) as Record<string, any>;
    const rows: LineCauseRow[] = [];
    const seen = new Set<string>();
    const push = (key: string, t: any) => {
      if (!t || seen.has(String(t._id))) return;
      seen.add(String(t._id));
      const real = !String(t._id).startsWith("temp_task_");
      rows.push({ key, id: real ? String(t._id) : null, shortId: real ? t.short_id ?? null : null, title: t.title ?? "", status: t.status ?? "open", running: !!t.workflow_run_id });
    };
    for (const key of keys) {
      const t = tasks[`temp_task_${key}`] ?? Object.values(tasks).find((x: any) => x?.client_key === key);
      push(key, t);
    }
    for (const sg of Object.values((s as any).signals ?? {}) as any[]) {
      if (sg?.subject !== subject) continue;
      const t = tasks[String(sg.task_id)];
      if (t && (!projectId || String(t.project_id) === projectId) && !isTerminalTaskStatus(t.status)) push(String(t._id), t);
    }
    return JSON.stringify(rows);
  });
  return useMemo(() => JSON.parse(sig) as LineCauseRow[], [sig]);
}

/** File a cause and start the line on one, with the refusal said in place. */
export function useLineCauseActions(projectId: string | null) {
  const [filed, setFiled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const file = useCallback((fields: LineCauseFields) => {
    if (!projectId) return null;
    const key = newClientKey();
    setError(null);
    setFiled((prev) => [key, ...prev]);
    const st = useInboxStore.getState();
    st.fileLineCause(key, projectId, fields).catch((e: unknown) => {
      if (!isRefusedDispatchError(e)) return;
      st.removeTaskStub(key);
      setFiled((prev) => prev.filter((k) => k !== key));
      setError(errorText(e));
    });
    return key;
  }, [projectId]);
  const start = useCallback((taskId: string) => {
    setError(null);
    useInboxStore.getState().startLineCause(taskId).catch((e: unknown) => {
      if (isRefusedDispatchError(e)) setError(errorText(e));
    });
  }, []);
  return { filed, file, start, error, clearError: () => setError(null) };
}
