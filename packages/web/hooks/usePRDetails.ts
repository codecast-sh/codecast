import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import * as Sentry from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useWatchEffect } from "./useWatchEffect";

export type PRDetailsRead = { loading: boolean; error?: string; retry: () => void };

export function usePRDetails(prId: string | undefined, headSha: string | undefined, section: "commits" | "checks" | null): PRDetailsRead {
  const refresh = useAction(api.prDetails.refresh);
  const [attempt, setAttempt] = useState(0);
  const key = prId && section ? `${prId}:${headSha ?? ""}:${section}:${attempt}` : null;
  const [result, setResult] = useState<{ key: string; error?: string }>();
  useWatchEffect(() => {
    if (!prId || !section || !key) return;
    let cancelled = false;
    setResult(undefined);
    void refresh({ pr_id: prId as Id<"pull_requests">, section }).then(() => {
      if (!cancelled) setResult({ key });
    }).catch((error: unknown) => {
      Sentry.captureException(error);
      if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [key, refresh]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { loading: !!key && result?.key !== key, error: result?.key === key ? result.error : undefined, retry };
}
