import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import * as Sentry from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { normalizeRepository } from "@codecast/shared/contracts";
import { useWatchEffect } from "./useWatchEffect";

export function usePRLookup(repository: string, number: number, enabled: boolean) {
  const fetchPull = useAction(api.githubApp.fetchPull);
  const canonicalRepository = normalizeRepository(repository);
  const [attempt, setAttempt] = useState(0);
  const key = `${canonicalRepository}:${number}:${attempt}`;
  const [result, setResult] = useState<{ key: string; reason?: string; error?: string }>();
  useWatchEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchPull({ repository: canonicalRepository, number }).then((response) => {
      if (!cancelled) setResult({ key, reason: response.ok ? undefined : response.reason ?? "unavailable" });
    }).catch((error: unknown) => {
      Sentry.captureException(error);
      if (!cancelled) setResult({ key, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [enabled, canonicalRepository, number, key, fetchPull]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { reason: result?.key === key ? result.reason : undefined, error: result?.key === key ? result.error : undefined, retry };
}
