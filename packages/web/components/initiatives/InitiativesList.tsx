"use client";
// /initiatives (docs/architecture/initiatives-projects-role-page.md I1): the
// goals the company is trying to reach, by status, each with who drives it,
// how it is going, when it is due and how far along it is. Rows, not cards: a
// person compares initiatives, so health and progress each run down a column.
// Paints from the store; progress derives at render from the tasks collection.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Flag, Plus } from "lucide-react";
import { INITIATIVE_STATUS_LABEL, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiatives, useBoardTasks } from "../../hooks/useInitiatives";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useWorkspaceArgs, workspaceStamp } from "../../hooks/useWorkspaceArgs";
import { groupInitiativesByStatus, initiativeHref, initiativeProgress, newInitiativeKey, subInitiatives } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { HealthChip, INITIATIVE_ACCENT, OwnerChip, ProgressBar, StatusGlyph, TargetDate } from "./InitiativeAtoms";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const ended = (r: InitiativeRow) => r.status === "completed" || r.status === "cancelled";

export function InitiativesList() {
  // An owner may be a role: the chips read the org roles, so keep them fed.
  useSyncOrgTreeFeeder();
  const rows = useInitiatives();
  const tasks = useBoardTasks();
  const now = useCoarseNow(60_000);
  const phone = useIsPhone();
  const groups = useMemo(() => groupInitiativesByStatus(rows), [rows]);
  const [creating, setCreating] = useState(false);

  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-initiatives-list>
      <style>{`
        @keyframes initiative-rise { from { opacity: 0; transform: translateY(5px); } }
        .initiative-row { animation: initiative-rise .26s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .initiative-row { animation: none; } }
      `}</style>
      <div className={cn("mx-auto w-full max-w-[1040px]", phone ? "px-3 pt-4 pb-10" : "px-8 pt-8 pb-16")}>
        <header className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className={cn("font-semibold tracking-tight leading-none", phone ? "text-[20px]" : "text-[26px]")} style={{ fontFamily: "var(--font-serif)" }}>Initiatives</h1>
            <p className="mt-2 text-[12.5px] leading-relaxed max-w-[60ch]" style={{ color: "var(--sol-text-muted)" }}>
              What the company is trying to reach. Each one names the projects that carry it and one owner who drives it.
            </p>
          </div>
          {!creating && rows.length > 0 && <NewButton onClick={() => setCreating(true)} />}
        </header>

        {creating && <CreateInitiative onDone={() => setCreating(false)} />}

        {rows.length === 0 && !creating ? (
          <EmptyState onCreate={() => setCreating(true)} />
        ) : (
          <div className="mt-7 space-y-7">
            {groups.map((g) => (
              <section key={g.status} data-initiative-group={g.status}>
                <h2 className="flex items-center gap-2 px-1 mb-2 text-[12.5px] font-medium" style={{ color: "var(--sol-text-secondary)" }}>
                  <StatusGlyph status={g.status} />
                  {INITIATIVE_STATUS_LABEL[g.status]}
                  <span className="tabular-nums font-normal" style={{ color: "var(--sol-text-dim)" }}>{g.rows.length}</span>
                </h2>
                <div className="rounded-xl border overflow-hidden" style={{ borderColor: HAIRLINE }}>
                  {g.rows.flatMap((r, i) => [
                    <Row key={r._id} row={r} index={i} now={now} phone={phone} progress={initiativeProgress(r, tasks)} />,
                    ...subInitiatives(rows, r._id).map((sub) => (
                      <Row key={sub._id} row={sub} index={i} now={now} phone={phone} progress={initiativeProgress(sub, tasks)} nested />
                    )),
                  ])}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ row, index, now, phone, progress, nested }: { row: InitiativeRow; index: number; now: number; phone: boolean; progress: ReturnType<typeof initiativeProgress>; nested?: boolean }) {
  const projects = row.project_ids.length;
  return (
    <Link
      href={initiativeHref(row)}
      className={cn("initiative-row group block no-underline border-t first:border-t-0 transition-colors hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:bg-sol-bg-highlight/60", phone ? "px-3 py-3" : "px-4 py-3")}
      style={{ borderColor: HAIRLINE, animationDelay: `${Math.min(index, 8) * 28}ms`, opacity: ended(row) ? 0.72 : 1 }}
      data-initiative-row={row.short_id || row._id}
      data-initiative-nested={nested ? "1" : undefined}
    >
      <div className={cn("grid items-center gap-x-4 gap-y-1.5", phone ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_150px_150px_64px_150px]")}>
        <div className={cn("min-w-0 flex items-center gap-2.5", nested && "pl-5")}>
          {nested ? <span className="w-3 h-px shrink-0" style={{ background: "var(--sol-text-dim)" }} aria-hidden /> : <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: ended(row) ? "var(--sol-text-dim)" : INITIATIVE_ACCENT }} />}
          <span className="min-w-0 truncate text-[13.5px] font-medium" style={{ color: "var(--sol-text)" }}>{row.title}</span>
          {row.short_id && <span className="shrink-0 text-[10.5px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>{row.short_id}</span>}
          {!nested && <span className="shrink-0 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{projects === 0 ? "no projects" : `${projects} ${projects === 1 ? "project" : "projects"}`}</span>}
        </div>
        {phone ? (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap pl-6">
            <OwnerChip owner={row.owner} size={14} />
            <HealthChip health={row.health} at={row.health_at} now={now} />
            <TargetDate ts={row.target_date} now={now} done={ended(row)} />
            <ProgressBar progress={progress} className="basis-full" />
          </div>
        ) : (
          <>
            <OwnerChip owner={row.owner} />
            <HealthChip health={row.health} at={row.health_at} now={now} />
            <span className="text-right"><TargetDate ts={row.target_date} now={now} done={ended(row)} /></span>
            <ProgressBar progress={progress} />
          </>
        )}
      </div>
    </Link>
  );
}

function NewButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 h-[32px] inline-flex items-center gap-1.5 px-3 rounded-lg text-[12.5px] font-medium hover:brightness-110 transition-[filter]" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }} data-initiative-new>
      <Plus className="w-3.5 h-3.5" /> New initiative
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-16 mx-auto max-w-md text-center" data-initiatives-empty>
      <span className="mx-auto w-11 h-11 rounded-full inline-flex items-center justify-center" style={{ background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 12%, transparent)`, color: INITIATIVE_ACCENT }}><Flag className="w-5 h-5" /></span>
      <h2 className="mt-4 text-[17px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>No initiatives yet</h2>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
        An initiative is a goal above your projects: what you are trying to reach, which projects carry it, who drives it, and how it is going.
      </p>
      <div className="mt-5 flex justify-center"><NewButton onClick={onCreate} /></div>
    </div>
  );
}

/** One field: the title. The row appears in the list in the same tick, owned
 *  by the person who made it, and its page is where the rest is said. */
function CreateInitiative({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const router = useRouter();
  const workspaceArgs = useWorkspaceArgs();
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const me = s.currentUser?._id ? String(s.currentUser._id) : null;
  const ready = workspaceArgs !== "skip" && !!me;
  const submit = () => {
    const clean = title.trim();
    if (!clean || workspaceArgs === "skip" || !me) return;
    const client_key = newInitiativeKey();
    useInboxStore.getState().createInitiative({ client_key, title: clean, owner: { kind: "user", user_id: me }, ...(workspaceStamp(workspaceArgs) as { workspace: "personal" | "team"; team_id?: string }) });
    onDone();
    router.push(`/initiatives/${client_key}`);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-6 flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: `color-mix(in srgb, ${INITIATIVE_ACCENT} 45%, transparent)` }} data-initiative-create>
      <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: INITIATIVE_ACCENT }} />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
        placeholder="What are you trying to reach?"
        className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] placeholder:text-sol-text-dim"
        aria-label="Initiative title"
      />
      <button type="button" onClick={onDone} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      <button type="submit" disabled={!title.trim() || !ready} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}>Create</button>
    </form>
  );
}
