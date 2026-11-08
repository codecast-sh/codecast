"use client";
// Teams already on codecast at the person's work domain (convex/teamDiscovery),
// shown above "Start your team" so a coworker's team is one press away instead
// of a second team being made beside it. Asking sends the admins a request.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Users } from "lucide-react";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";

export function DomainTeams() {
  const found = useQueryNoThrow(api.teamDiscovery.teamsForMyDomain, {}).data;
  const requestToJoin = useMutation(api.teamDiscovery.requestToJoin);
  const [asking, setAsking] = useState<string | null>(null);
  const [asked, setAsked] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState("");

  const open = (found?.teams ?? []).filter((t) => t.request !== "declined");
  if (open.length === 0) return null;

  const ask = (id: Id<"teams">) => {
    setError("");
    setAsking(id);
    requestToJoin({ team_id: id })
      .then(() => setAsked((s) => new Set(s).add(id)))
      .catch((err) => setError(humanizeConvexError(err)))
      .finally(() => setAsking(null));
  };

  return (
    <div className="space-y-2" data-domain-teams>
      {open.map((t) => {
        const pending = t.request === "pending" || asked.has(t._id);
        return (
          <div key={t._id} className="flex items-center gap-3 rounded-xl border border-sol-border bg-sol-bg-alt/40 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sol-violet/15 text-sol-violet">
              <Users className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-sol-text">{t.name}</span>
              <span className="block text-xs text-sol-text-dim">
                <span className="tabular-nums">{t.member_count}</span> from @{found?.domain}
              </span>
            </span>
            {pending ? (
              <span className="text-xs text-sol-text-muted">Asked</span>
            ) : (
              <button
                type="button"
                onClick={() => ask(t._id)}
                disabled={asking === t._id}
                className="tf-ghost h-8 rounded-md border border-sol-border px-3 text-sm text-sol-text hover:bg-sol-bg-alt disabled:opacity-50"
              >
                {asking === t._id ? "Asking…" : "Ask to join"}
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs text-sol-red">{error}</p>}
      <div className="flex items-center gap-3 pt-2 text-xs text-sol-text-dim">
        <span className="h-px flex-1 bg-sol-border/60" />
        or start a new one
        <span className="h-px flex-1 bg-sol-border/60" />
      </div>
    </div>
  );
}
