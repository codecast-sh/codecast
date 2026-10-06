import { useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { AtSign } from "lucide-react";
import { toast } from "sonner";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useInboxStore } from "../../store/inboxStore";

const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

export type DiscoveryNudge = { domain: string; coworkers_outside: number };

/**
 * The admin's "let coworkers find this team" suggestion (convex/teamDiscovery.ts
 * discoveryNudge). Asked once per mount, never subscribed: the answer scans the
 * users table, which every heartbeat writes. Null for non-admins, findable
 * teams, and admins without a proven work domain.
 */
export function useDiscoveryNudge(teamId: Id<"teams"> | null, enabled = true): DiscoveryNudge | null {
  const convex = useConvex();
  const [nudge, setNudge] = useState<DiscoveryNudge | null>(null);
  useMountEffect(() => {
    if (!teamId || !enabled) return;
    let alive = true;
    convex.query(api.teamDiscovery.discoveryNudge, { team_id: teamId }).then((n) => { if (alive) setNudge(n); }).catch(() => {});
    return () => { alive = false; };
  });
  return nudge;
}

export function coworkersLine(nudge: DiscoveryNudge, teamName: string): string {
  const n = nudge.coworkers_outside;
  return n > 0
    ? `${n} ${n === 1 ? "person" : "people"} with @${nudge.domain} addresses ${n === 1 ? "uses" : "use"} codecast but ${n === 1 ? "isn't" : "aren't"} on ${teamName}.`
    : `Coworkers who sign up with an @${nudge.domain} address can find ${teamName} and ask to join.`;
}

/** The team feed card for an admin: one click opens the team to their domain. */
export function TeamFindableNudge({ teamId, teamName }: { teamId: Id<"teams">; teamName: string }) {
  const isAdmin = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId))?.role === "admin");
  const snoozedAt = useInboxStore((s) => s.clientState.dismissed?.team_findable_nudge ?? 0);
  const dismiss = useInboxStore((s) => s.updateClientDismissed);
  const nudge = useDiscoveryNudge(teamId, isAdmin);
  const setDiscoverable = useMutation(api.teamDiscovery.setDiscoverable);
  const [done, setDone] = useState(false);
  if (!nudge || done || Date.now() - snoozedAt < SNOOZE_MS) return null;

  const turnOn = () => {
    setDone(true);
    setDiscoverable({ team_id: teamId, enabled: true })
      .then(() => toast.success(`@${nudge.domain} coworkers can now find ${teamName}`, { description: "You approve each request in Settings → Team." }))
      .catch((err) => {
        setDone(false);
        toast.error(err instanceof Error ? err.message : "Could not turn that on");
      });
  };

  return (
    <div className="tf-accent-card flex w-full items-center gap-3 rounded-lg border px-4 py-3">
      <AtSign className="tf-accent-text h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-sol-text">{coworkersLine(nudge, teamName)}</span>
        <span className="block text-xs text-sol-text-muted">
          Let people with a verified @{nudge.domain} address find this team and ask to join. You approve each one.
        </span>
      </span>
      <button type="button" onClick={() => dismiss("team_findable_nudge", Date.now())} className="shrink-0 text-xs text-sol-text-muted hover:text-sol-text">
        Not now
      </button>
      <button type="button" onClick={turnOn} className="tf-accent-text shrink-0 text-sm font-medium">
        Let them find it
      </button>
    </div>
  );
}
