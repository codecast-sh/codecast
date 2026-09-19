"use client";
// The role page's Wakes tab (docs/architecture/org-roles-standing.md T6): the
// wake log, newest first, each wake with its causes and its frame size. The
// conversation view's wake card links here ("Why did this wake me") with the
// wake's short id, which lands highlighted.
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE } from "../../messageMarkdown";
import { useRoleWakes, type RoleWakeRow } from "../../../hooks/useScopeQueries";
import { queryProblem } from "../../../lib/scopePage";
import { compactAge } from "../../../lib/threadState";
import type { OrgRole } from "../orgTypes";
import { dedupeTitles } from "../../roleWake";

const STATUS_META: Record<RoleWakeRow["status"], { label: string; color: string; hint: string }> = {
  delivered: { label: "delivered", color: "var(--sol-green)", hint: "A frame went out to the standing session" },
  dropped: { label: "dropped", color: "var(--sol-text-dim)", hint: "Nothing new since the last frame; the rows were cleared" },
  held: { label: "held", color: "var(--sol-yellow)", hint: "A cap or a pause kept the rows waiting; they ride the next wake" },
};

export function ScopeWakesTab({ role, highlight, now }: { role: OrgRole; highlight: string | null; now: number }) {
  const { data, error, missing } = useRoleWakes(role._id);
  const problem = queryProblem(error, missing, "The wake log");
  const target = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line no-restricted-syntax -- brings the highlighted wake into view as the list fills
  useEffect(() => { target.current?.scrollIntoView({ block: "center" }); }, [data?.length, highlight]);
  return (
    <div className="space-y-2" data-wakes-tab>
      <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>
        Every time the rail woke {role.name}: what queued it, whether a frame went out, and how large it was. Held wakes ride the next frame as its backlog.
      </p>
      {problem && <p className="text-[12px]" style={{ color: "var(--sol-red)" }}>{problem}</p>}
      {data && data.length === 0 && <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>No wakes yet.</p>}
      {(data ?? []).map((w) => {
        const meta = STATUS_META[w.status] ?? STATUS_META.delivered;
        const hit = w.short_id === highlight;
        return (
          <div key={w._id} ref={hit ? target : undefined} className="rounded-xl border px-4 py-3" data-wake={w.short_id}
            style={{ borderColor: hit ? "var(--sol-violet)" : "color-mix(in srgb, var(--sol-border) 28%, transparent)", background: hit ? "color-mix(in srgb, var(--sol-violet) 6%, var(--sol-card))" : "var(--sol-card)" }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-medium tabular-nums" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>{w.short_id}</span>
              <span className="inline-flex items-center h-[18px] px-1.5 rounded-md text-[10px] font-medium" title={meta.hint} style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 14%, transparent)` }}>{meta.label}</span>
              <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{w.causes.length} {w.causes.length === 1 ? "cause" : "causes"}{w.frame_chars > 0 ? ` · ${w.frame_chars.toLocaleString()} chars` : ""}</span>
              <span className="ml-auto text-[10px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={new Date(w.created_at).toLocaleString()}>{compactAge(Math.max(0, now - w.created_at))}</span>
            </div>
            {w.causes.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {w.causes.map((c, i) => (
                  <div key={i} className="flex gap-2 text-[12px] leading-[1.45]" style={{ color: "var(--sol-text)" }}>
                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-violet) 70%, transparent)" }} aria-hidden />
                    <div className="min-w-0 flex-1 [&_p]:m-0">
                      <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>{dedupeTitles(c)}</ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
