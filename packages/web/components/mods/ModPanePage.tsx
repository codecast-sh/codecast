// /m/<mod>/<pane>: one pane of a mod, full page. The header names the mod and
// its panes; the body is whatever the mod draws. Pane props handed over by
// $.ui.open reach the render as e.props, with the URL's query as `query`.

import { useMemo, useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import type { ModSurface } from "@codecast/shared/contracts/mods";
import { ModSurfaceView } from "./ModSurface";
import { ModLogList } from "./ModLogList";
import { modNavigate, takePaneProps } from "../../lib/mods/host";
import { useModRows, useModRuntime } from "../../lib/mods/useMods";

export function ModPanePage({ mod, pane }: { mod: string; pane?: string }) {
  const rows = useModRows();
  const row = rows.find((r) => r.name === mod);
  const runtime = useModRuntime(mod);
  const [showLogs, setShowLogs] = useState(false);
  const panes = row?.manifest.panes ?? [];
  const active = pane ?? panes[0]?.id;
  const query = typeof window !== "undefined" ? Object.fromEntries(new URLSearchParams(window.location.search)) : {};
  const handed = active ? takePaneProps(mod, active) : undefined;
  const propsSig = JSON.stringify([handed ?? null, query]);
  const surface = useMemo<ModSurface | null>(
    () => (active ? { kind: "pane", id: active, props: { ...(handed ?? {}), query } } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, propsSig],
  );

  if (!row) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        <div className="text-[15px] text-sol-text">No mod named <span className="font-mono">{mod}</span></div>
        <div className="mt-2 text-[13px] text-sol-text-muted">It may not have synced yet, or it belongs to someone else. <button className="text-sol-blue hover:underline" onClick={() => modNavigate("/mods")}>See your mods</button></div>
      </div>
    );
  }
  const errors = runtime?.logs.filter((l) => l.level === "error").length ?? 0;
  const statusTone = !row.enabled ? "var(--sol-text-dim)" : runtime?.status === "failed" ? "var(--sol-red)" : runtime?.status === "ready" ? "var(--sol-green)" : "var(--sol-yellow)";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-sol-border px-5 py-2.5">
        <span className="flex size-7 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--sol-violet)_14%,transparent)] text-sol-violet">
          <DynamicIcon name={(row.manifest.icon ?? "blocks") as any} size={15} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-sol-text">{row.title ?? row.name}</span>
            <span className="size-1.5 rounded-full" style={{ background: statusTone }} title={!row.enabled ? "off" : runtime?.status ?? "starting"} />
          </div>
          <div className="text-[11px] text-sol-text-dim">{row.version ? `v${row.version}` : "dev"} · rev {row.rev}{row.owner_name && !row.is_mine ? ` · by ${row.owner_name}` : ""}</div>
        </div>
        {panes.length > 1 ? (
          <nav className="ml-4 flex gap-1">
            {panes.map((p) => (
              <button
                key={p.id}
                onClick={() => modNavigate(`/m/${mod}/${p.id}`)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${p.id === active ? "bg-[color-mix(in_srgb,var(--sol-text)_8%,transparent)] text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
              >
                {p.title}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className={`rounded-md px-2 py-1 text-[12px] ${showLogs ? "text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
          >
            Logs{errors ? <span className="ml-1 text-sol-red tabular-nums">{errors}</span> : null}
          </button>
          <button onClick={() => modNavigate("/mods")} className="rounded-md px-2 py-1 text-[12px] text-sol-text-muted hover:text-sol-text">All mods</button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-6xl px-5 py-5">
            {!row.enabled ? (
              <div className="py-12 text-center text-[13px] text-sol-text-muted">This mod is off. Turn it on from <button className="text-sol-blue hover:underline" onClick={() => modNavigate("/mods")}>Mods</button>.</div>
            ) : !surface ? (
              <div className="py-12 text-center text-[13px] text-sol-text-muted">This mod declares no panes.</div>
            ) : (
              <ModSurfaceView runtime={runtime} surface={surface} instance="page" />
            )}
          </div>
        </main>
        {showLogs ? (
          <aside className="w-[380px] shrink-0 overflow-auto border-l border-sol-border bg-sol-bg-alt/40 px-3 py-3">
            <ModLogList runtime={runtime} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
