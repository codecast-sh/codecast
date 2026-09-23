import { useMemo, useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { ShareImpactBand } from "../team/ShareImpactBand";
import { TeamVisibilityControl } from "./TeamVisibilityControl";
import { useShareImpact } from "../../hooks/useShareImpact";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { formatShortDate } from "../../lib/utils";
import { formatSessionCount, shareActionLabel, type ProjectCounts } from "../../lib/team/shareImpact";
import { teamVisibilityOption, type TeamSharingFacts } from "../../lib/teamVisibility";

export type ShareReviewTeam = TeamSharingFacts & { _id: Id<"teams"> };

export type ShareReviewRequest = {
  /** The newest checkout: names the row and carries the rule. */
  path: string;
  /** Every checkout and worktree the share covers. */
  paths: string[];
  teamId: Id<"teams">;
  /** The mapping's current share start when the repo is already shared. */
  shareSince: number | null;
  /** True when the repo already flows to this team and the person is narrowing it. */
  existing: boolean;
};

type SessionRow = {
  _id: Id<"conversations">;
  title: string | null;
  started_at: number | null;
  message_count: number;
  is_private: boolean;
  team_visibility: string | null;
  auto_shared: boolean;
};

/**
 * The review before a repo starts (or keeps) flowing to a team: the team's
 * level, the share start as a choice, the count and span that choice
 * exposes, and the sessions themselves with a "keep private" box on each.
 * Nothing is written until the person confirms.
 */
export function ShareReviewDialog({ request, team, projects, busy, onCancel, onConfirm }: {
  request: ShareReviewRequest | null;
  team: ShareReviewTeam | null;
  projects: ProjectCounts[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: { since: number | null; keepPrivate: Id<"conversations">[] }) => void;
}) {
  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="bg-sol-bg border-sol-border sm:max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col">
        {request && team && (
          <ReviewBody key={`${request.path}|${request.teamId}`} request={request} team={team} projects={projects} busy={busy} onCancel={onCancel} onConfirm={onConfirm} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewBody({ request, team, projects, busy, onCancel, onConfirm }: {
  request: ShareReviewRequest;
  team: ShareReviewTeam;
  projects: ProjectCounts[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: { since: number | null; keepPrivate: Id<"conversations">[] }) => void;
}) {
  const name = request.path.split("/").pop() || request.path;
  const [since, setSince] = useState<number | null>(request.shareSince);
  const [keep, setKeep] = useState<Set<string>>(() => new Set());
  // One repository under review, however many checkouts carry it: the
  // sentence and the button count repos, not paths.
  const impact = { ...useShareImpact(request.paths, projects, since), repos: 1 };
  const list = useQueryNoThrow(api.users.listConversationsForPath, { path_prefixes: request.paths.slice(0, 12) }).data as
    | { rows: SessionRow[]; total: number; truncated: boolean }
    | undefined;
  const level = teamVisibilityOption(team.visibility);

  // A row's fate under the choice on screen: kept private by hand, older
  // than the share start, or exposed. The checkbox only exists on the last.
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
  const keptCount = [...fates.values()].filter((f) => f === "kept").length;
  const toggleKeep = (id: string) =>
    setKeep((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const base = shareActionLabel(impact, since) ?? "Share";
  const confirmLabel = keptCount > 0 ? `${base}, keep ${keptCount} private` : base;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sol-text">
          <Eye className="h-5 w-5 text-sol-cyan" />
          {request.existing ? `${name} is shared with ${team.name}` : `Share ${name} with ${team.name}?`}
        </DialogTitle>
        <DialogDescription className="text-sol-text-muted">
          Every session in this repository, now and later, follows your level for the team. Review what that exposes, then confirm.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-3 py-1 pr-1">
        <div className="max-h-24 overflow-y-auto rounded-md bg-sol-bg-alt px-3 py-2 font-mono text-xs text-sol-text-muted">
          {request.paths.map((path) => <div key={path} className="truncate">{path}</div>)}
          {request.paths.length > 1 && (
            <div className="mt-1 font-sans text-[11px] text-sol-text-dim">One rule covers all {request.paths.length} checkouts and their worktrees.</div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-sol-border/60 px-4 py-2.5">
          <div className="min-w-0 text-sm text-sol-text">
            <span className="font-medium">{team.name} sees</span>
            <span className="text-sol-text-muted"> {level.sees} of the sessions you share with it.</span>
          </div>
          <TeamVisibilityControl team={team} />
        </div>

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

        <div className="rounded-lg border border-sol-border/60">
          <div className="flex items-baseline justify-between gap-2 border-b border-sol-border/40 px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-sol-text-dim">Sessions</span>
            <span className="text-xs text-sol-text-dim tabular-nums">
              {list
                ? list.rows.length < list.total
                  ? `newest ${list.rows.length} of ${formatSessionCount(list.total, list.truncated)}`
                  : formatSessionCount(list.total, list.truncated)
                : "loading"}
              {keptCount > 0 && ` · ${keptCount} kept private`}
            </span>
          </div>
          {list && list.rows.length === 0 && (
            <p className="px-4 py-3 text-xs text-sol-text-dim">No sessions here yet.</p>
          )}
          <ul className="max-h-[38dvh] overflow-y-auto divide-y divide-sol-border/30">
            {(list?.rows ?? []).map((row) => {
              const fate = fates.get(row._id) ?? "exposed";
              const dim = fate === "hidden" || fate === "older";
              return (
                <li key={row._id} className={`flex items-center gap-3 px-4 py-1.5 text-xs ${dim ? "opacity-55" : ""}`}>
                  {fate === "hidden" ? (
                    <Lock className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" aria-label="Hidden by hand" />
                  ) : fate === "older" ? (
                    <EyeOff className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" aria-label="Before the share start" />
                  ) : (
                    <input
                      type="checkbox"
                      checked={fate === "kept"}
                      onChange={() => toggleKeep(row._id)}
                      aria-label={`Keep "${row.title || "Untitled"}" private`}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--sol-cyan)]"
                    />
                  )}
                  <span className={`min-w-0 flex-1 truncate ${fate === "kept" ? "line-through text-sol-text-dim" : "text-sol-text"}`}>
                    {row.title || "Untitled"}
                  </span>
                  <span className="shrink-0 text-sol-text-dim tabular-nums">
                    {row.message_count > 0 && `${row.message_count} msg · `}
                    {row.started_at != null ? formatShortDate(row.started_at) : ""}
                  </span>
                  <span className="w-24 shrink-0 text-right text-[10px] uppercase tracking-wide text-sol-text-dim">
                    {fate === "hidden" ? "hidden by hand" : fate === "older" ? "stays private" : fate === "kept" ? "keep private" : row.is_private ? "becomes visible" : "visible"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <DialogFooter className="min-w-0 flex-wrap gap-2 sm:space-x-0">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="cyan"
          onClick={() => onConfirm({ since, keepPrivate: [...fates.entries()].filter(([, f]) => f === "kept").map(([id]) => id as Id<"conversations">) })}
          disabled={busy || level.value === "hidden"}
        >
          {busy ? "Sharing" : request.existing ? confirmLabel.replace(/^Share /, "Keep sharing ") : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
