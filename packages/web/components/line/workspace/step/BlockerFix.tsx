"use client";
// The act that clears a station blocked by a bug in a file it runs (lib/line/blocker): the fix. An open
// task that names the file is that fix, one press away; with none, the fix is filed here, its title the
// blocker's own clause and its description the station's words whole, in the blocked problem's project.
// Nothing is filed until the person confirms; once filed, the task is the act (it names the file).
import { useMemo, useState } from "react";
import { blockerClause, fixTaskFor } from "../../../../lib/line/blocker";
import { useInboxStore } from "../../../../store/inboxStore";
import { workspaceRows } from "../../../../hooks/useWorkspaceCollection";
import { activeWorkspaceKeyOf, workspaceKeyOfRow } from "../../../../lib/workspaceScope";

type TaskLite = { _id: string; workspace?: string | null; short_id?: string; title?: string; description?: string; status?: string; project_id?: string | null };

const scans = new WeakMap<object, Map<string, string>>();

/** The open task that fixes `file`, read from the store by a signature (none of the blocked problems themselves). */
function useFixTask(file: string, not: ReadonlyArray<string>): { id: string; ref: string | null; title: string } | null {
  const notKey = not.join(",");
  const sig = useInboxStore((s) => {
    // The scan reruns only when the tasks collection changes, not on every store write.
    const tasks = (s.tasks ?? {}) as Record<string, TaskLite>;
    const key = `${file}\u0001${notKey}`;
    const seen = scans.get(tasks)?.get(key);
    if (seen !== undefined) return seen;
    // The fix lives in the blocked problem's workspace.
    const home = not[0] ? tasks[not[0]] : undefined;
    const t = fixTaskFor(file, workspaceRows("tasks", tasks, (home ? workspaceKeyOfRow(home) : null) ?? activeWorkspaceKeyOf(s)), new Set(notKey ? notKey.split(",") : []));
    const out = t ? `${t._id}\u0000${t.short_id ?? ""}\u0000${t.title ?? ""}` : "";
    (scans.get(tasks) ?? scans.set(tasks, new Map()).get(tasks)!).set(key, out);
    return out;
  });
  return useMemo(() => { if (!sig) return null; const [id, ref, title] = sig.split("\u0000"); return { id, ref: ref || null, title }; }, [sig]);
}

export function BlockerFix({ file, reason, step, problems }: {
  file: string;
  /** The station's own words for what blocks it, whole. */
  reason: string;
  /** The blocked step's name, for the filed fix. */
  step: string;
  /** The blocked problems: never their own fix, and named in a filed one. */
  problems: ReadonlyArray<{ id: string; ref: string | null }>;
}) {
  const projectId = useInboxStore((s) => (problems[0] ? ((s.tasks ?? {}) as Record<string, TaskLite>)[problems[0].id]?.project_id ?? null : null));
  const fix = useFixTask(file, problems.map((p) => p.id));
  const [filing, setFiling] = useState(false);
  const [title, setTitle] = useState(() => `Fix ${blockerClause(reason, file)}`);
  const [err, setErr] = useState<string | null>(null);
  if (fix) {
    return (
      <span className="lw-closed-acts sp-fix" data-line-blocker-fix={fix.ref ?? fix.id}>
        <a className="lw-act" data-primary="" href={`/tasks/${fix.ref ?? fix.id}`}>Open the fix</a>
        <span className="sp-fix-name"><span className="lw-num">{fix.ref}</span> {fix.title}</span>
      </span>
    );
  }
  if (!filing) return <button type="button" className="lw-act" data-primary="" onClick={() => setFiling(true)} data-line-blocker-file={file}>File the fix…</button>;
  const refs = problems.map((p) => p.ref).filter(Boolean).join(", ");
  const description = `${step} is blocked on ${refs || "the line"} until this lands on main.\n\n${step} said: ${reason}`;
  const file_ = () => {
    setErr(null);
    void useInboxStore.getState().createTask({ title: title.trim(), description, ...(projectId ? { project_id: projectId } : {}) })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not file it"));
  };
  return (
    <form className="sp-fix-form" data-line-blocker-filing={file} onSubmit={(e) => { e.preventDefault(); if (title.trim()) file_(); }}>
      <input className="sp-fix-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="The fix's title" />
      <span className="sp-fix-acts">
        {err && <span className="lwp-sub-err" role="alert">{err}</span>}
        <button type="button" className="lw-link" onClick={() => setFiling(false)}>Cancel</button>
        <button type="submit" className="lw-act" data-primary="" disabled={!title.trim()}>File it</button>
      </span>
    </form>
  );
}
