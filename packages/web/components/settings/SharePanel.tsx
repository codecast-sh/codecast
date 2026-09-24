import { useMemo, useState } from "react";
import { ChevronDown, Eye, EyeOff, Lock } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Button } from "../ui/button";
import { TeamIcon } from "../TeamIcon";
import { ShareImpactBand } from "../team/ShareImpactBand";
import { useShareImpact } from "../../hooks/useShareImpact";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { formatShortDate } from "../../lib/utils";
import { formatDateRange, formatSessionCount, type ProjectCounts } from "../../lib/team/shareImpact";
import { currentMembershipVisibility, teamVisibilityOption, type TeamSharingFacts } from "../../lib/teamVisibility";

export type SharePanelTeam = TeamSharingFacts & {
  _id: Id<"teams">;
  icon?: string | null;
  icon_color?: string | null;
};

/** The rule a row is under today. */
export type ShareCurrent =
  | { kind: "private" }
  | { kind: "lock"; inherited?: boolean }
  | {
      kind: "team";
      teamId: Id<"teams">;
      teamName: string;
      shareSince: number | null;
      /** Shared through a rule on another checkout of the same repository. */
      inherited?: boolean;
      /** Shared through the team's default share paths, not a rule of this row. */
      isDefault?: boolean;
    };

export type ShareChoice =
  | { kind: "private" }
  | { kind: "lock" }
  | { kind: "team"; teamId: Id<"teams">; since: number | null; keepPrivate: Id<"conversations">[] };

type SessionRow = {
  _id: Id<"conversations">;
  title: string | null;
  started_at: number | null;
  message_count: number;
  is_private: boolean;
  team_visibility: string | null;
};

/** The row's button: who can open it now. Opens the panel under the row. */
export function ShareTrigger({ name, current, open, onClick }: {
  name: string;
  current: ShareCurrent;
  open: boolean;
  onClick: () => void;
}) {
  const shared = current.kind === "team" && !current.isDefault;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`Who can open ${name}`}
      className={`flex min-w-[132px] items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
        shared
          ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
          : current.kind === "lock"
            ? "border-sol-green/60 bg-sol-green/10 text-sol-text"
            : "border-sol-border bg-sol-bg text-sol-text-muted hover:bg-sol-bg-highlight/40 hover:text-sol-text"
      } ${open ? "ring-1 ring-sol-cyan/50" : ""}`}
    >
      <span className="flex items-center gap-2">
        {current.kind === "lock" ? <Lock className="h-4 w-4 text-sol-green" /> : current.kind === "team" ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        <span>
          {current.kind === "lock" ? "Never shared" : current.kind === "team" ? current.teamName : "Only me"}
          {current.kind !== "private" && current.inherited && <span className="ml-0.5 text-xs text-sol-text-muted" title="Set on another checkout of this repository">(repo)</span>}
          {current.kind === "team" && current.isDefault && <span className="ml-0.5 text-xs text-sol-text-muted" title="Shared by your team's share paths">(auto)</span>}
        </span>
      </span>
      <ChevronDown className={`h-3 w-3 opacity-50 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

/**
 * Who can open a repository, decided in place under its row: pick who, pick
 * how much, read what that exposes, then apply. Nothing is written until the
 * button is pressed, and the button names the change.
 */
export function SharePanel({ name, paths, isRepository = false, local, syncsOnShare = false, projects, teams, current, busy, onApply, onClose }: {
  name: string;
  /** Each session's last activity on this machine, for a folder the server has
   *  not seen: the counts then come from here. */
  local?: number[];
  /** The folder is not syncing; sharing it turns its sync on. */
  syncsOnShare?: boolean;
  /** A git repository: its rule also reaches its other clones and worktrees. */
  isRepository?: boolean;
  /** Every checkout and worktree the rule covers. */
  paths: string[];
  projects: ProjectCounts[];
  teams: SharePanelTeam[];
  current: ShareCurrent;
  busy: boolean;
  onApply: (choice: ShareChoice) => void;
  onClose: () => void;
}) {
  const currentPick = current.kind === "team" && !current.isDefault ? String(current.teamId) : current.kind === "lock" ? "lock" : "private";
  const [pick, setPick] = useState<string>(currentPick);
  const team = teams.find((t) => String(t._id) === pick) ?? null;
  const existingSince = current.kind === "team" && String(current.teamId) === pick ? current.shareSince : null;
  const [since, setSince] = useState<number | null>(existingSince);
  const [keep, setKeep] = useState<Set<string>>(() => new Set());
  const choose = (next: string) => {
    setPick(next);
    setSince(current.kind === "team" && String(current.teamId) === next ? current.shareSince : null);
    setKeep(new Set());
  };

  const serverImpact = { ...useShareImpact(paths, projects, team ? since : null), repos: 1 };
  const impact = local && local.length > 0
    ? {
        ...serverImpact,
        sessions: local.length,
        first: local[local.length - 1],
        last: local[0],
        older: team && since != null ? local.filter((t) => t < since).length : 0,
        truncated: false,
        exact: true,
      }
    : serverImpact;
  // The newest sessions only, fifty at a time: a folder of thousands is read
  // in full by its stats row, never here. The date choice above is the tool
  // for a big folder; the list is for keeping a few named sessions private.
  const [limit, setLimit] = useState(50);
  const [filter, setFilter] = useState("");
  const list = useQueryNoThrow(api.users.listConversationsForPath, team ? { path_prefixes: paths.slice(0, 12), limit } : "skip").data as
    | { rows: SessionRow[]; total: number; truncated: boolean }
    | undefined;
  const fates = useMemo(() => {
    const out = new Map<string, "hidden" | "older" | "kept" | "exposed">();
    for (const row of list?.rows ?? []) {
      if (row.team_visibility === "private") out.set(row._id, "hidden");
      else if (since != null && row.started_at != null && row.started_at < since) out.set(row._id, "older");
      else if (keep.has(row._id)) out.set(row._id, "kept");
      else out.set(row._id, "exposed");
    }
    return out;
  }, [list, since, keep]);
  const kept = [...fates.entries()].filter(([, f]) => f === "kept").map(([id]) => id as Id<"conversations">);
  const toggleKeep = (id: string) => setKeep((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const level = team ? teamVisibilityOption(currentMembershipVisibility(team)) : null;
  const unchanged = pick === currentPick && (!team || (since === existingSince && kept.length === 0));
  const currentTeamName = current.kind === "team" ? current.teamName : "";
  const action =
    team ? (pick === currentPick ? "Save" : `Share with ${team.name}`)
    : pick === "lock" ? "Never share"
    : current.kind === "lock" ? "Unlock"
    : current.kind === "team" ? `Stop sharing with ${currentTeamName}`
    : "Keep private";
  const span = formatDateRange(impact.first, impact.last, Date.now(), impact.truncated);
  const count = impact.sessions > 0 ? `its ${formatSessionCount(impact.sessions, impact.truncated)}${span ? ` (${span})` : ""}` : "its sessions";

  const option = (value: string, label: React.ReactNode, disabled = false, title?: string) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={pick === value}
      disabled={disabled}
      title={title}
      onClick={() => choose(value)}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
        pick === value ? "border-sol-cyan bg-sol-cyan/15 text-sol-text" : "border-sol-border text-sol-text-muted hover:text-sol-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-3 border-t border-sol-border/40 bg-sol-bg-alt/40 px-4 py-3 sm:px-5" data-share-panel>
      <div role="radiogroup" aria-label={`Who can open ${name}`} className="flex flex-wrap items-center gap-1.5">
        {option("private", <><EyeOff className="h-3.5 w-3.5" />Only me</>)}
        {teams.map((t) => {
          const hidden = currentMembershipVisibility(t) === "hidden";
          return option(
            String(t._id),
            <><TeamIcon icon={t.icon} color={t.icon_color} className="h-3.5 w-3.5" />{t.name}</>,
            hidden,
            hidden ? `Your level for ${t.name} is Hidden. Raise it in the team header first.` : undefined,
          );
        })}
        {option("lock", <><Lock className="h-3.5 w-3.5" />Never share</>)}
      </div>

      {team && level ? (
        <>
          <ShareImpactBand
            teamName={team.name}
            memberCount={team.member_count}
            visibility={level.value}
            selectedNames={[name]}
            impact={impact}
            since={since}
            onSinceChange={setSince}
            controls="scope"
          />
          {paths.length > 1 && <p className="text-[11px] text-sol-text-dim">Covers all {paths.length} checkouts of this repository and their worktrees.</p>}
          {syncsOnShare && (
            <p className="text-xs text-sol-text-muted">
              Sharing starts syncing this folder, past sessions included. The choice above decides which of them {team.name} sees.
            </p>
          )}
          {(!list || list.rows.length > 0) && <div className="rounded-md border border-sol-border/50">
            <div className="flex items-center justify-between gap-3 border-b border-sol-border/40 px-3 py-1.5 text-[11px] text-sol-text-dim">
              <span className="shrink-0">Untick a session to keep it private</span>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by title"
                aria-label="Filter sessions by title"
                className="min-w-0 flex-1 bg-transparent text-right text-[11px] text-sol-text placeholder:text-sol-text-dim focus:outline-none"
              />
              <span className="shrink-0 tabular-nums">
                {list ? (impact.exact && impact.sessions > list.rows.length ? `newest ${list.rows.length} of ${formatSessionCount(impact.sessions)}` : formatSessionCount(list.rows.length)) : "loading"}
                {kept.length > 0 && ` · ${kept.length} kept private`}
              </span>
            </div>
            <ul className="max-h-64 overflow-y-auto divide-y divide-sol-border/30">
              {(list?.rows ?? []).filter((row) => !filter || (row.title ?? "Untitled").toLowerCase().includes(filter.toLowerCase())).map((row) => {
                const fate = fates.get(row._id) ?? "exposed";
                const open = fate === "exposed";
                return (
                  <li key={row._id} className={`flex items-center gap-3 px-3 py-1 text-xs ${open || fate === "kept" ? "" : "opacity-50"}`}>
                    <input
                      type="checkbox"
                      checked={open}
                      disabled={fate === "hidden" || fate === "older"}
                      onChange={() => toggleKeep(row._id)}
                      aria-label={`Share "${row.title || "Untitled"}"`}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--sol-cyan)]"
                    />
                    <span className={`min-w-0 flex-1 truncate ${open ? "text-sol-text" : "text-sol-text-dim"}`}>{row.title || "Untitled"}</span>
                    <span className="shrink-0 text-sol-text-dim tabular-nums">{row.started_at != null ? formatShortDate(row.started_at) : ""}</span>
                    <span className="w-24 shrink-0 text-right text-[10px] text-sol-text-dim">
                      {fate === "hidden" ? "hidden by hand" : fate === "older" ? "before start" : fate === "kept" ? "stays private" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            {list && list.truncated && limit < 1000 && (
              <button
                type="button"
                onClick={() => setLimit((n) => Math.min(n + 100, 1000))}
                className="w-full border-t border-sol-border/40 px-3 py-1.5 text-left text-[11px] text-sol-cyan hover:bg-sol-bg-highlight/30"
              >
                Show 100 older sessions
              </button>
            )}
          </div>}
        </>
      ) : (
        <p className="text-xs text-sol-text-muted">
          {pick === "lock"
            ? `No rule can ever share ${count}${isRepository ? ", a share on another clone of this repository included" : ""}.`
            : `Only you can open ${count}.`}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{unchanged ? "Close" : "Cancel"}</Button>
        {!unchanged && <Button
          variant="cyan"
          size="sm"
          disabled={busy || (!!team && level?.value === "hidden")}
          onClick={() => onApply(team ? { kind: "team", teamId: team._id, since, keepPrivate: kept } : pick === "lock" ? { kind: "lock" } : { kind: "private" })}
        >
          {busy ? "Saving" : action}
        </Button>}
      </div>
    </div>
  );
}
