// Filling in a commit's diff, apart from the repository browser so the phone's
// commit screen can use it without the browser's transport.
import { useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

/**
 * The fate of a read handed to a checkout: nothing while it is open or once
 * it is answered, the reason once every checkout (and GitHub after them)
 * could not answer it. `args === null` watches nothing.
 */
export function useLocalReadStatus(args: Record<string, unknown> | null): { error: Error | undefined } {
  const status = useQueryNoThrow(api.repos.readRequestStatus, (args ?? "skip") as never);
  const failed = status.data?.status === "failed" ? status.data.error ?? "No checkout could answer this read" : undefined;
  return useMemo(() => ({ error: failed ? new Error(failed) : undefined }), [failed]);
}

/**
 * Fetch one commit's files when the row arrived without them.
 *
 * A commit that came in by webhook carries its message and counts but no
 * patches, so the page asks for them once and the commit row updates itself
 * through the store feeder. Answers with the backend's own reason when there is
 * nothing to fetch, so the page can tell "still reading" from "nothing to read".
 */
export function useEnsureCommitFiles(
  repository: string | undefined,
  sha: string | undefined,
  enabled: boolean,
): { pending: boolean; reason: string | undefined; error: Error | undefined } {
  const ensure = useAction(api.repos.ensureCommitFiles);
  const [state, setState] = useState<{ key: string; pending: boolean; reason?: string; error?: Error }>({
    key: "",
    pending: false,
  });
  const key = enabled && repository && sha ? `${repository}@${sha}` : "";

  useWatchEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ key, pending: true });
    void ensure({ repository, sha })
      .then((result: any) => {
        if (!cancelled) setState({ key, pending: false, reason: result?.reason });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ key, pending: false, error: e instanceof Error ? e : new Error(String(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, ensure]);

  const current = state.key === key ? state : { pending: !!key, reason: undefined, error: undefined };
  const requested = useLocalReadStatus(current.reason === "requested" ? { repository, kind: "commit", ref: sha } : null);
  return { pending: current.pending, reason: requested.error ? undefined : current.reason, error: current.error ?? requested.error };
}
