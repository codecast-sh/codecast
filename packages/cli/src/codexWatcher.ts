// Codex transcript watching now runs through the shared TranscriptDirWatcher
// (transcriptDirWatcher.ts) configured via transcriptDirWatcherConfig("codex").
// This module keeps only the app-server rollout classifier, which the daemon and
// `cast status` (index.ts) both import.

// A Codex rollout whose session_meta marks it as started by codecast is synced live
// by the app-server path, NOT the transcript file loop. Both the watchdog's stale
// scan and the `cast status` stuck-sync report skip these so an app-server rollout
// (whose file ledger the app-server path never advances) is not mistaken for a
// wedged file-sync.
export function isAppServerManagedCodexSessionHead(headContent: string): boolean {
  const firstLine = headContent.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return false;

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { originator?: string; source?: string | { custom?: string } };
    };
    if (parsed.type !== "session_meta") return false;
    if (parsed.payload?.originator === "codecast") return true;
    return typeof parsed.payload?.source === "object" && parsed.payload.source?.custom === "codecast";
  } catch {
    return firstLine.includes('"originator":"codecast"') || firstLine.includes('"source":{"custom":"codecast"}');
  }
}
