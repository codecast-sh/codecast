"use client";

// Shared renderer for a dynamic-workflow (Anthropic) run: phases -> agents with
// status / tokens / result. Used compact in the inline conversation card
// (ConversationView) and full on the Workflows dashboard. One definition, two surfaces.

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

export function DynamicRunView({ run, compact }: { run: any; compact?: boolean }) {
  const agents: any[] = run?.node_statuses || [];
  const declaredPhases: { title: string; detail?: string }[] = run?.phases || [];
  const phases = declaredPhases.length
    ? declaredPhases
    : Array.from(new Set(agents.map((a) => a.phase).filter(Boolean))).map((t: any) => ({ title: t }));
  const inPhase = (title: string) => agents.filter((a) => (a.phase || "") === title);
  const unphased = agents.filter((a) => !a.phase || !phases.some((p) => p.title === a.phase));

  const renderAgent = (a: any) => {
    const m = wfStatusMeta(a.status);
    return (
      <div key={a.node_id} className="flex items-center gap-1.5 text-[11px] min-w-0">
        {m.icon
          ? <span className={`${m.cls} text-[10px] flex-shrink-0`}>{m.icon}</span>
          : <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot}`} />}
        <span className="text-sol-text-muted truncate flex-shrink-0 max-w-[160px]">{a.label || a.node_id}</span>
        {a.tokens ? <span className="text-sol-text-dim/60 text-[10px] flex-shrink-0">{wfFmtTokens(a.tokens)}</span> : null}
        {a.result_preview && !compact
          ? <span className="text-sol-text-dim/70 truncate">— {a.result_preview}</span>
          : null}
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
            <div className="flex flex-col gap-0.5 pl-2.5 border-l border-sol-cyan/15">
              {ags.map(renderAgent)}
            </div>
          </div>
        );
      })}
      {unphased.length > 0 && (
        <div className="flex flex-col gap-0.5 pl-2 border-l border-sol-border/20">{unphased.map(renderAgent)}</div>
      )}
    </div>
  );
}
