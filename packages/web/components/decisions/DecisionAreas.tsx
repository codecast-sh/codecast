"use client";
// The Team view's two area controls (convex/decisionAreas.ts,
// decisionShareOut.ts), for the workspace's admins:
//
// - Change areas: the members and the projects each decides for, and a box to
//   say who covers what in plain words. Mapping the words (one model call)
//   shows the new map in place of the current one; Apply writes it.
// - Share out: the area rule rerun over the open decisions. The press reads
//   who would get what and opens the shared confirm (consequential
//   SwitchReview); nothing moves before the confirm.
import { useMemo, useState } from "react";
import { useAction, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Shuffle, SquarePen } from "lucide-react";
import { areasText, takesDecisions, type AreaAssignment } from "@codecast/shared/contracts/decisionAreas";
import { useInboxStore } from "../../store/inboxStore";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { shareOutLedger, type ShareOutPreview } from "../consequential/ledgers";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";

type MapRow = { user_id: string; name: string; takes_decisions: boolean; projects: Array<{ id: string; title: string }> };
type Mapped = { assignments: MapRow[]; unplaced: string[]; text: string };

const BUTTON = "flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sol-border/40 text-xs text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors disabled:opacity-40";

/** The team id behind a workspace key, when the viewer is that team's admin. A boolean subscription: the roster re-pushes on presence. */
function useAdminTeam(workspace: string | null): string | null {
  const admin = useInboxStore((s) => {
    const me = String(s.currentUser?._id ?? "");
    return (s.teamMembers ?? []).some((m: any) => String(m._id) === me && m.role === "admin");
  });
  return admin && workspace?.startsWith("team:") ? workspace.slice(5) : null;
}

/** The current map, from the store's roster and projects; it wakes on the areas' own fields only. */
function useCurrentAreas(): MapRow[] {
  const sig = useInboxStore((s) => (s.teamMembers ?? []).filter((m: any) => !m.is_bot)
    .map((m: any) => `${m._id}\u0001${m.name ?? m.email ?? ""}\u0001${takesDecisions(m)}\u0001${(m.focus_project_ids ?? []).map((id: string) => `${id}=${(s.projects as any)?.[id]?.title ?? ""}`).join(",")}`).join("\u0002"));
  return useMemo(() => (sig ? sig.split("\u0002") : []).map((line) => {
    const [user_id, name, takes, focus] = line.split("\u0001");
    return {
      user_id,
      name: name || "a teammate",
      takes_decisions: takes === "true",
      projects: focus ? focus.split(",").map((pair) => { const [id, title] = pair.split("="); return { id, title: title || "A project" }; }) : [],
    };
  }), [sig]);
}

export function AreasMap({ rows, before }: { rows: MapRow[]; before?: MapRow[] }) {
  const was = new Map((before ?? []).map((r) => [r.user_id, r.projects.map((p) => p.id).sort().join(",") + (r.takes_decisions ? "" : "!")]));
  return (
    <ul className="flex flex-col divide-y divide-sol-border/40 rounded-md border border-sol-border/50" data-areas-map>
      {rows.map((r) => {
        const changed = before && was.get(r.user_id) !== r.projects.map((p) => p.id).sort().join(",") + (r.takes_decisions ? "" : "!");
        return (
          <li key={r.user_id} className="flex items-start gap-3 px-3 py-2 text-[12.5px]" data-areas-person={r.name} data-changed={changed || undefined}>
            <span className={`w-36 shrink-0 truncate ${changed ? "text-sol-blue" : "text-sol-text"}`}>{changed && <i aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sol-blue align-middle" />}{r.name}</span>
            <span className="flex min-w-0 flex-wrap gap-1">
              {r.projects.length === 0 && <span className="text-sol-text-dim">No areas</span>}
              {r.projects.map((p) => <span key={p.id} className="rounded bg-sol-bg-alt px-1.5 py-0.5 text-sol-text">{p.title}</span>)}
              {!r.takes_decisions && <span className="rounded px-1.5 py-0.5 text-sol-orange">Takes none</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const Chord = () => <span className="flex items-center gap-0.5"><KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap></span>;

type MapWords = (teamId: string, words: string) => Promise<Mapped | { error: string }>;
type ReadShareOut = (teamId: string) => Promise<ShareOutPreview | { error: string }>;

export function ChangeAreas({ teamId }: { teamId: string }) {
  const mapAreas = useAction(api.decisionAreas.mapAreas);
  return <ChangeAreasView teamId={teamId} mapWords={(team, words) => mapAreas({ team_id: team as Id<"teams">, words }) as Promise<Mapped | { error: string }>} />;
}

/** Change areas with its one server read handed in, so it mounts without a Convex client. */
export function ChangeAreasView({ teamId, mapWords }: { teamId: string; mapWords: MapWords }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [mapped, setMapped] = useState<Mapped | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useCurrentAreas();
  const applyDecisionAreas = useInboxStore((s) => s.applyDecisionAreas);
  const currentText = useMemo(() => areasText(current.map((r) => ({ user_id: r.user_id, project_ids: r.projects.map((p) => p.id), takes_decisions: r.takes_decisions })), (u) => current.find((r) => r.user_id === u)?.name ?? "", (p) => current.flatMap((r) => r.projects).find((x) => x.id === p)?.title ?? ""), [current]);

  const show = (next: boolean) => {
    setOpen(next);
    setMapped(null);
    setError(null);
    setWords(next ? currentText : "");
  };
  const map = async () => {
    if (!words.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r: any = await mapWords(teamId, words);
      if (r?.error) setError(r.error);
      else setMapped(r as Mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (!mapped) return;
    applyDecisionAreas(teamId, mapped.assignments.map(({ user_id, projects, takes_decisions }): AreaAssignment => ({ user_id, project_ids: projects.map((p) => p.id), takes_decisions })));
    show(false);
  };

  return (
    <>
      <button type="button" className={BUTTON} onClick={() => show(true)} data-change-areas>
        <SquarePen className="w-3 h-3" /><span className="cq-header-collapse">Change areas</span>
      </button>
      {open && (
        <Dialog open onOpenChange={show}>
          <DialogContent className="w-[34rem] max-w-[calc(100vw-1.5rem)] gap-3 border-sol-border bg-sol-bg p-5 text-sol-text" data-change-areas-dialog>
            <DialogTitle className="text-[15px] font-semibold">Who decides for which areas</DialogTitle>
            <DialogDescription className="sr-only">Each new decision about a project goes to whoever covers it, fewest open first.</DialogDescription>
            <AreasMap rows={mapped?.assignments ?? current} before={mapped ? current : undefined} />
            {mapped && mapped.unplaced.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-[12px]" data-areas-unplaced>
                <span className="text-sol-orange">No project matches</span>
                {mapped.unplaced.map((u) => <span key={u} className="rounded border border-sol-orange/40 px-1.5 py-0.5 text-sol-text">{u}</span>)}
              </div>
            )}
            <textarea
              value={words}
              onChange={(e) => { setWords(e.target.value); setMapped(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (mapped) apply(); else void map(); } }}
              rows={3}
              placeholder="Samvit: deals, intros and calling; Jason: desk and evals"
              aria-label="Who covers what"
              className="w-full resize-none rounded border border-sol-border bg-sol-bg-alt px-2 py-1.5 text-[12.5px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue"
              data-areas-words
            />
            {error && <div className="text-[12px] text-sol-red" role="alert" data-areas-error>{error}</div>}
            <div className="flex items-center justify-end gap-2 text-[12px]">
              <button type="button" onClick={() => show(false)} className="px-2 py-1 text-sol-text-dim hover:text-sol-text">Cancel</button>
              {mapped ? (
                <button type="button" onClick={apply} className="flex items-center gap-1.5 rounded border border-sol-blue/50 bg-sol-blue/10 px-2.5 py-1 text-sol-blue" data-areas-apply>
                  Apply<Chord />
                </button>
              ) : (
                <button type="button" onClick={() => void map()} disabled={busy || !words.trim() || words.trim() === currentText} className="flex items-center gap-1.5 rounded border border-sol-border px-2.5 py-1 text-sol-text disabled:opacity-40" data-areas-map-words>
                  {busy ? "Reading…" : "Preview"}<Chord />
                </button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function ShareOut({ teamId }: { teamId: string }) {
  const convex = useConvex();
  return <ShareOutView teamId={teamId} readPreview={(team) => convex.query(api.decisionShareOut.preview, { team_id: team as Id<"teams"> }) as Promise<ShareOutPreview | { error: string }>} />;
}

/** Share out with its one server read handed in, so it mounts without a Convex client. */
export function ShareOutView({ teamId, readPreview }: { teamId: string; readPreview: ReadShareOut }) {
  const [preview, setPreview] = useState<ShareOutPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shareOutDecisions = useInboxStore((s) => s.shareOutDecisions);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const r: any = await readPreview(teamId);
      if (r?.error) setError(r.error);
      else setPreview(r as ShareOutPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={BUTTON} onClick={() => void open()} disabled={busy} data-share-out>
        <Shuffle className="w-3 h-3" /><span className="cq-header-collapse">{busy ? "Reading…" : "Share out"}</span>
      </button>
      {error && <span className="text-[11px] text-sol-red" role="alert" data-share-out-error>{error}</span>}
      {preview && (
        <SwitchReview
          ledger={shareOutLedger(preview)}
          onClose={() => setPreview(null)}
          onConfirm={() => {
            shareOutDecisions(teamId, preview.moves.map(({ decision_id, to }) => ({ decision_id, to })));
            setPreview(null);
          }}
        />
      )}
    </>
  );
}

/** The Team view's area controls, for the workspace's admins. */
export function TeamAreaControls({ workspace }: { workspace: string | null }) {
  const teamId = useAdminTeam(workspace);
  if (!teamId) return null;
  return (
    <div className="flex items-center gap-1.5" data-team-area-controls>
      <ChangeAreas teamId={teamId} />
      <ShareOut teamId={teamId} />
    </div>
  );
}
