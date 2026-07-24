import { useCallback, useEffect, useState } from "react";
import type {
  PrincipalRuntime,
  PrincipalRuntimeInspection,
} from "@/store/local-first/principalRuntime";

declare global {
  interface Window {
    /** Development-only, payload-free local-state diagnostics for browser QA. */
    __CODECAST_LOCAL_FIRST_INSPECT__?: () => Promise<PrincipalRuntimeInspection>;
  }
}

function inspectorRequested(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("localFirstInspector") === "1";
}

function compactAge(ageMs: number): string {
  if (ageMs < 1_000) return `${Math.max(0, Math.round(ageMs))}ms`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1_000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${Math.round(ageMs / 3_600_000)}h`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-sol-border bg-sol-bg-alt px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-sol-text-dim">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium text-sol-text" title={String(value)}>
        {value}
      </div>
    </div>
  );
}

/**
 * A deliberately payload-free operational view of the principal runtime.
 * It is tree-shaken from production behavior and is opt-in on localhost via
 * `?localFirstInspector=1`. The same redacted snapshot is exposed to the
 * connected Chrome session through `window.__CODECAST_LOCAL_FIRST_INSPECT__`.
 */
export function LocalFirstInspector({ runtime }: { runtime: PrincipalRuntime }) {
  const [visible, setVisible] = useState(inspectorRequested);
  const [inspection, setInspection] = useState<PrincipalRuntimeInspection | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const refresh = useCallback(async () => {
    const next = await runtime.inspect();
    setInspection(next);
    return next;
  }, [runtime]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__CODECAST_LOCAL_FIRST_INSPECT__ = () => runtime.inspect();
    return () => {
      delete window.__CODECAST_LOCAL_FIRST_INSPECT__;
    };
  }, [runtime]);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const unsubscribe = runtime.subscribe(() => { void refresh(); });
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh, runtime, visible]);

  const close = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("localFirstInspector");
    window.history.replaceState(window.history.state, "", url);
    setVisible(false);
  }, []);

  const copy = useCallback(async () => {
    if (!inspection) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(inspection, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1_500);
  }, [inspection]);

  if (!import.meta.env.DEV || !visible) return null;

  const lifecycle = inspection?.lifecycle;
  const store = inspection?.store;
  const legacyTotal = store
    ? store.legacy.collectionRowCount + store.legacy.metaRowCount +
      store.legacy.outboxCount + store.legacy.conversationCacheCount
    : 0;

  return (
    <aside
      aria-label="Local-first inspector"
      className="fixed bottom-3 right-3 z-[10000] flex max-h-[min(720px,calc(100vh-24px))] w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-sol-border bg-sol-card shadow-2xl"
    >
      <header className="flex items-center justify-between gap-3 border-b border-sol-border px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${lifecycle?.storageHealth === "healthy" ? "bg-sol-green" : "bg-sol-yellow"}`}
            />
            <h2 className="truncate text-sm font-semibold text-sol-text">Local-first inspector</h2>
          </div>
          <p className="mt-0.5 text-[11px] text-sol-text-dim">Redacted runtime metadata only</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-md border border-sol-border px-2 py-1 text-[11px] text-sol-text-muted hover:text-sol-text"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-sol-border px-2 py-1 text-[11px] text-sol-text-muted hover:text-sol-text"
          >
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close local-first inspector"
            className="rounded-md px-2 py-1 text-xs text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
          >
            ×
          </button>
        </div>
      </header>

      <div className="overflow-y-auto p-3.5">
        {!inspection ? (
          <p className="text-xs text-sol-text-muted">Reading durable runtime metadata…</p>
        ) : (
          <div className="space-y-4">
            <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Gate" value={lifecycle?.phase ?? "unknown"} />
              <Metric label="Storage" value={lifecycle?.storageHealth ?? "unknown"} />
              <Metric label="Head" value={lifecycle?.head ?? "—"} />
              <Metric label="Schema" value={store?.schemaVersion ?? "—"} />
              <Metric label="Generation" value={lifecycle?.generation ?? "—"} />
              <Metric label="Principal epoch" value={lifecycle?.principalEpoch ?? "—"} />
              <Metric label="Grants" value={store?.grantCount ?? 0} />
              <Metric label="Legacy rows" value={legacyTotal} />
            </section>

            {store && (
              <section>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-sol-text-muted">
                    Materialized views
                  </h3>
                  <span className="truncate text-[10px] text-sol-text-dim" title={store.storeKeyHint}>
                    store {store.storeKeyHint}
                  </span>
                </div>
                {store.views.length === 0 ? (
                  <p className="rounded-md border border-dashed border-sol-border p-2.5 text-xs text-sol-text-dim">
                    No v2 views committed yet.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {store.views.map((view) => (
                      <div key={`${view.contractId}:${view.key}`} className="rounded-md border border-sol-border bg-sol-bg-alt p-2.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-sol-text" title={view.contractId}>
                              {view.contractId}
                            </div>
                            <div className="truncate text-[10px] text-sol-text-dim" title={view.key}>{view.key}</div>
                          </div>
                          <span className="rounded bg-sol-card px-1.5 py-0.5 text-[10px] text-sol-text-muted">
                            {view.access}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-sol-text-dim">
                          <span>revision {view.revision ?? "—"}</span>
                          <span>writer {view.writerEpoch}</span>
                          <span>source {view.sourceSequence ?? "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {store && (
              <section>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sol-text-muted">
                  Durable commands
                </h3>
                {store.commands.length === 0 ? (
                  <p className="rounded-md border border-dashed border-sol-border p-2.5 text-xs text-sol-text-dim">
                    No command journal entries.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {store.commands.map((command) => (
                      <div key={command.id} className="flex items-center justify-between gap-3 rounded-md border border-sol-border bg-sol-bg-alt px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs text-sol-text" title={command.type}>{command.type}</div>
                          <div className="truncate text-[10px] text-sol-text-dim" title={command.id}>{command.id}</div>
                        </div>
                        <div className="shrink-0 text-right text-[10px] text-sol-text-muted">
                          <div>{command.status}</div>
                          <div className="text-sol-text-dim">{compactAge(command.ageMs)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {(inspection.inspectionError || inspection.lastFailure) && (
              <section className="rounded-md border border-sol-yellow bg-sol-bg-alt p-2.5 text-xs text-sol-text-muted">
                {inspection.inspectionError && <div>Inspection: {inspection.inspectionError}</div>}
                {inspection.lastFailure && (
                  <div>
                    Last failure: {inspection.lastFailure.reason} ({inspection.lastFailure.category})
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
