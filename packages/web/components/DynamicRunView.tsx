"use client";

// Shared renderer for a dynamic-workflow (Anthropic) run: phases -> agents with
// status / tokens / result. Used compact in the inline conversation card
// (ConversationView) and full on the Workflows dashboard. One definition, two surfaces.
//
// Agent rows double as a session list, styled after the inbox's subagent sub-rows
// (GlobalSessionPanel's isSubagent branch): violet ↳ corner arrow + faint violet left
// border, session title as the primary text, a ">"-prefixed preview line saying what
// the session is doing, and the same right-side dot vocabulary (green ping = live).
// The daemon syncs each agent's transcript as a conversation (session_id
// "agent-<id>"), the run queries attach it as `node.session`, and rows that have one
// open that session on click (side panel on desktop, route on mobile).

import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";

export function wfStatusMeta(status?: string): { icon: string; cls: string; dot: string } {
  switch (status) {
    case "completed": return { icon: "✓", cls: "text-emerald-400", dot: "" };
    case "failed":    return { icon: "✗", cls: "text-sol-red", dot: "" };
    case "running":   return { icon: "", cls: "text-sol-yellow", dot: "bg-sol-yellow animate-pulse" };
    default:          return { icon: "", cls: "text-sol-text-dim", dot: "bg-sol-text-dim/40" };
  }
}

export function wfFmtTokens(n?: number): string {
  if (!n) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

// Right-cluster status indicator, in the inbox sub-row's dot vocabulary:
// running = green ping (live), completed = ✓, failed = ✗, pending = idle gray.
function AgentStatusDot({ status }: { status?: string }) {
  switch (status) {
    case "running":
      return (
        <span className="relative flex h-1.5 w-1.5 flex-shrink-0" title="Running">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-sol-green" />
        </span>
      );
    case "completed":
      return <span className="text-emerald-400 text-[10px] leading-none flex-shrink-0" title="Completed">{"✓"}</span>;
    case "failed":
      return <span className="text-sol-red text-[10px] leading-none flex-shrink-0" title="Failed">{"✗"}</span>;
    default:
      return <span className="w-1.5 h-1.5 rounded-full bg-gray-500/40 ring-1 ring-gray-500/20 flex-shrink-0" title="Queued" />;
  }
}

export function DynamicRunView({ run, compact }: { run: any; compact?: boolean }) {
  const openLinkedSession = useOpenLinkedSession();
  const agents: any[] = run?.node_statuses || [];
  const declaredPhases: { title: string; detail?: string }[] = run?.phases || [];
  const phases = declaredPhases.length
    ? declaredPhases
    : Array.from(new Set(agents.map((a) => a.phase).filter(Boolean))).map((t: any) => ({ title: t }));
  const inPhase = (title: string) => agents.filter((a) => (a.phase || "") === title);
  const unphased = agents.filter((a) => !a.phase || !phases.some((p) => p.title === a.phase));

  const renderAgent = (a: any) => {
    const s = a.session;
    const label = a.label || a.node_id;
    // Primary text mirrors the inbox row: the session's title. Until the transcript
    // syncs (or for label-only nodes) the workflow label stands in.
    const title = s?.title || label;
    // Preview line ("what is this session doing"): live last-tool activity while
    // running, the result once done. The label rides along when the title claimed
    // the primary slot so the workflow role (impl/review/…) stays scannable.
    const doing = (a.status === "running" ? a.activity : a.result_preview) || a.activity || a.result_preview;
    const preview = [s?.title ? label : null, doing].filter(Boolean).join(" — ");
    const clickable = !!s;
    const open = clickable ? (e: React.SyntheticEvent) => { e.stopPropagation(); openLinkedSession(s); } : undefined;
    return (
      <div
        key={a.node_id}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={open}
        onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open!(e); } } : undefined}
        title={clickable ? `Open session: ${s.title || label}` : undefined}
        className={`min-w-0 px-1.5 py-0.5 border-l transition-colors ${
          clickable
            ? "cursor-pointer border-l-violet-500/15 hover:bg-violet-500/[0.06]"
            : "border-l-violet-500/10 opacity-60"
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Corner arrow (↳) — same child-of-parent mark the inbox subagent rows use */}
          <svg className="w-3 h-3 text-violet-400/60 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} role="img" aria-label="Workflow agent">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 4v12h12" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 12l4 4-4 4" />
          </svg>
          <span className="truncate text-xs leading-tight flex-1 text-gray-400">{title}</span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {a.tokens ? <span className="text-[9px] tabular-nums text-sol-text-dim/50">{wfFmtTokens(a.tokens)}</span> : null}
            {s?.message_count > 0 && (
              <span className="text-[9px] tabular-nums text-sol-text-dim/50">{s.message_count}</span>
            )}
            <AgentStatusDot status={a.status} />
          </div>
        </div>
        {preview && (
          <div className="text-[10px] text-gray-500 mt-0.5 truncate leading-snug pl-[18px]">
            <span className="text-gray-600 mr-0.5">{">"}</span>
            {preview}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {phases.map((p) => {
        const ags = inPhase(p.title);
        if (!ags.length) return null;
        return (
          <div key={p.title} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] uppercase tracking-wider text-sol-cyan/70 font-semibold">{p.title}</span>
              <span className="text-[9px] text-sol-text-dim/50">{ags.length}</span>
            </div>
            <div className="flex flex-col gap-px pl-1.5">
              {ags.map(renderAgent)}
            </div>
          </div>
        );
      })}
      {unphased.length > 0 && (
        <div className="flex flex-col gap-px pl-1.5">{unphased.map(renderAgent)}</div>
      )}
    </div>
  );
}
