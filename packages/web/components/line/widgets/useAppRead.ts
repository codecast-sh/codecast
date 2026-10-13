"use client";
// One read through a connected app's declared reader (convex sources/app.read), for the viewer's active workspace,
// asked once per page load and argument set. A read changes nothing in the app; a failed one is asked again next time.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useActiveWorkspaceKey } from "../../../hooks/useWorkspaceCollection";
import { useWatchEffect } from "../../../hooks/useWatchEffect";

export type AppRead = { ok: true; text: string } | { ok: false; error: string };
const reads = new Map<string, Promise<AppRead>>();

/** The answer of `reader` on the app source named `app`, or null while it is being read (or `want` is false). */
export function useAppRead(app: string, reader: string, args: Record<string, unknown>, want = true): AppRead | null {
  const run = useAction(api.sources.app.read);
  const workspace = useActiveWorkspaceKey();
  const argsJson = JSON.stringify(args);
  const key = `${workspace}:${app}:${reader}:${argsJson}`;
  const [got, setGot] = useState<{ key: string; read: AppRead } | null>(null);
  useWatchEffect(() => {
    if (!workspace || !want) return;
    let p = reads.get(key);
    if (!p) {
      const scope = workspace.startsWith("team:") ? { workspace: "team" as const, team_id: workspace.slice(5) as never } : { workspace: "personal" as const };
      p = run({ ...scope, source: app, reader, args_json: argsJson })
        .then((r): AppRead => (r.ok && r.text ? { ok: true, text: r.text } : { ok: false, error: r.error ?? "no answer" }))
        .catch((): AppRead => ({ ok: false, error: "could not reach codecast" }));
      reads.set(key, p);
      void p.then((r) => { if (!r.ok) reads.delete(key); });
    }
    let live = true;
    void p.then((read) => { if (live) setGot({ key, read }); });
    return () => { live = false; };
  }, [key, workspace, want]);
  return got?.key === key ? got.read : null;
}
