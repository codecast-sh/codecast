// Filing and starting a change to the line (line-map.md LX6), for every
// surface that asks for one: the Change composer on a map panel, and "Send
// through the line" on a station's prompt. The store paints the cause at
// once (lineSlice.fileLineCause); a refusal takes the painted row back and
// says why in place.
import { useCallback, useMemo, useState } from "react";
import { useInboxStore } from "../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../store/mutativeMiddleware";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { isTaskStubId, taskStubId } from "../../../store/taskStub";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import type { LineCauseFields } from "../../../lib/line/lineCause";

export type LineCauseRow = { key: string; id: string | null; shortId: string | null; title: string; status: string; running: boolean };

/** A cause this panel filed: its client key, the title it was filed with,
 *  and the server's id once the filing is acknowledged. */
export type FiledCause = { key: string; title: string; id?: string };

const newClientKey = () => `lc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it";

const signalSig = (sg: { subject?: string; task_id?: string }) => `${sg.subject ?? ""}|${sg.task_id ?? ""}`;
const taskSig = (t: any) => (t ? `${t._id}|${t.short_id ?? ""}|${t.title ?? ""}|${t.status ?? ""}|${t.workflow_run_id ?? ""}|${t.project_id ?? ""}` : "");

/**
 * The causes filed against one node: the ones this panel filed, and the open
 * ones whose signals name the node as subject. Signals are read through the
 * project's workspace (useWorkspaceCollection); tasks only by id, so the
 * panel wakes on a change to one of its own causes and nothing else.
 */
export function useLineCauses(projectId: string | null, subject: string, filed: FiledCause[]): LineCauseRow[] {
  const workspace = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { workspace?: string | null }>)[projectId]?.workspace ?? null) : null));
  const signals = useWorkspaceCollection<{ subject?: string; task_id?: string }>("signals", signalSig, workspace);
  const named = useMemo(() => [...new Set(signals.filter((sg) => sg.subject === subject && sg.task_id).map((sg) => String(sg.task_id)))], [signals, subject]);
  // Each cause by id: the painted stub, and the server's id once acknowledged.
  const ids = useMemo(() => [...filed.flatMap((f) => (f.id ? [f.id, taskStubId(f.key)] : [taskStubId(f.key)])), ...named], [filed, named]);
  const sig = useInboxStore((s) => ids.map((id) => taskSig((s.tasks as Record<string, any>)[id])).join("\n"));
  return useMemo(() => {
    const tasks = useInboxStore.getState().tasks as Record<string, any>;
    const rows: LineCauseRow[] = [];
    const seen = new Set<string>();
    const push = (key: string, t: any) => {
      const real = !isTaskStubId(String(t._id));
      rows.push({ key, id: real ? String(t._id) : null, shortId: real ? t.short_id ?? null : null, title: t.title ?? "", status: t.status ?? "open", running: !!t.workflow_run_id });
      seen.add(String(t._id));
    };
    for (const f of filed) {
      const t = (f.id && tasks[f.id]) || tasks[taskStubId(f.key)];
      // Between the server row superseding the stub and the filing's answer,
      // neither key holds it: it still reads as filing.
      if (!t) rows.push({ key: f.key, id: null, shortId: null, title: f.title, status: "open", running: false });
      else if (!seen.has(String(t._id))) push(f.key, t);
    }
    for (const id of named) {
      const t = tasks[id];
      if (t && !seen.has(id) && (!projectId || String(t.project_id) === projectId) && !isTerminalTaskStatus(t.status)) push(id, t);
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the task rows it reads
  }, [sig, filed, named, projectId]);
}

/** File a cause and start the line on one, with the refusal said in place. */
export function useLineCauseActions(projectId: string | null) {
  const [filed, setFiled] = useState<FiledCause[]>([]);
  const [error, setError] = useState<string | null>(null);
  const file = useCallback((fields: LineCauseFields) => {
    if (!projectId) return null;
    const key = newClientKey();
    setError(null);
    setFiled((prev) => [{ key, title: fields.title }, ...prev]);
    const st = useInboxStore.getState();
    st.fileLineCause(key, projectId, fields).then((r) => {
      const id = r?.task_id;
      if (id) setFiled((prev) => prev.map((f) => (f.key === key ? { ...f, id: String(id) } : f)));
    }, (e: unknown) => {
      if (!isRefusedDispatchError(e)) return;
      st.removeTaskStub(key);
      setFiled((prev) => prev.filter((f) => f.key !== key));
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
