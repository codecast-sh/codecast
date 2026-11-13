// A mod's pane drawn inside a message: what a `/m/<mod>/<pane>` link alone on
// a line becomes. It is the running pane itself, not a picture of it, so an
// agent iterating on a mod shows the person each push land in the thread, and
// the header's revision ticks as it does.

import { useMemo, useRef, useState } from "react";
import { DynamicIcon } from "lucide-react/dynamic";
import type { ModSurface } from "@codecast/shared/contracts/mods";
import { ModSurfaceView } from "./ModSurface";
import { modNavigate } from "../../lib/mods/host";
import { useModRows, useModRuntime } from "../../lib/mods/useMods";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export function ModPaneEmbed({ mod, pane, caption }: { mod: string; pane?: string; caption?: string }) {
  const rows = useModRows();
  const row = rows.find((r) => r.name === mod && r.is_mine !== false) ?? rows.find((r) => r.name === mod);
  const runtime = useModRuntime(mod);
  const paneId = pane ?? row?.manifest.panes?.[0]?.id;
  const paneTitle = row?.manifest.panes?.find((p) => p.id === paneId)?.title;
  const surface = useMemo<ModSurface | null>(() => (paneId ? { kind: "pane", id: paneId, props: { embedded: true } } : null), [paneId]);
  const href = `/m/${mod}${paneId ? `/${paneId}` : ""}`;

  // A new revision flashes the header for a moment: the push the person is watching for.
  const lastRev = useRef(row?.rev);
  const [fresh, setFresh] = useState(false);
  useWatchEffect(() => {
    if (row?.rev === undefined) return;
    if (lastRev.current !== undefined && row.rev !== lastRev.current) {
      setFresh(true);
      const t = setTimeout(() => setFresh(false), 1600);
      lastRev.current = row.rev;
      return () => clearTimeout(t);
    }
    lastRev.current = row.rev;
  }, [row?.rev]);

  const note = !row ? `No mod named ${mod} that you can see.`
    : !row.enabled ? `${row.title ?? mod} is turned off.`
    : row.is_mine === false && !runtime ? `${row.title ?? mod} is a teammate's mod you have not installed.`
    : !paneId ? `${row.title ?? mod} has no panes.`
    : null;

  return (
    <figure className="not-prose my-3 overflow-hidden rounded-xl border border-sol-border bg-sol-bg" data-mod-embed={mod}>
      <header
        className="flex items-center gap-2 border-b border-sol-border px-3 py-2 transition-colors duration-700"
        style={{ background: fresh ? "color-mix(in srgb, var(--sol-violet) 14%, var(--sol-card))" : "var(--sol-card)" }}
      >
        <DynamicIcon name={(row?.manifest.icon ?? "blocks") as any} size={14} className="shrink-0 text-sol-violet" />
        <span className="truncate text-[12.5px] font-medium text-sol-text">{row?.title ?? mod}{paneTitle && paneTitle !== row?.title ? ` · ${paneTitle}` : ""}</span>
        {row ? <span className={`font-mono text-[10.5px] ${fresh ? "text-sol-violet" : "text-sol-text-dim"}`}>rev {row.rev}</span> : null}
        {runtime?.status === "ready" ? <span className="size-1.5 rounded-full bg-sol-green" title="running" /> : null}
        <button onClick={() => modNavigate(note && row ? "/mods" : href)} className="ml-auto text-[12px] text-sol-blue hover:underline">
          {note && row ? "Mods" : "Open"}
        </button>
      </header>
      <div className="max-h-[560px] overflow-auto p-3">
        {note ? (
          <div className="py-6 text-center text-[12.5px] text-sol-text-muted">{note}</div>
        ) : surface ? (
          <ModSurfaceView runtime={runtime} surface={surface} instance={`embed:${caption ?? ""}`} />
        ) : null}
      </div>
      {caption ? <figcaption className="border-t border-sol-border px-3 py-1.5 text-[12px] text-sol-text-muted">{caption}</figcaption> : null}
    </figure>
  );
}
