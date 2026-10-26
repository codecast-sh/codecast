"use client";

import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useMyTeams, type ShareTeam } from "../../hooks/useDeviceSharing";
import { useAccountPool } from "../../hooks/useSyncAccountPool";
import { TeamSharePills } from "./TeamSharePills";

/**
 * Whether one of your accounts is in a team's pool: one pill per team, the
 * same control a machine's team access uses. Opening asks once, because every
 * teammate's machines get a sealed copy of the account's setup-token;
 * taking it back is one press. The account must have a live setup-token
 * (the row's mint button), which the caller checks.
 */
export function AccountPoolPill({ deviceId, email }: { deviceId: string; email: string }) {
  const teams = useMyTeams();
  const pool = useAccountPool();
  const setAccountShares = useInboxStore((s) => s.setAccountShares);
  if (teams.length === 0) return null;
  const key = email.toLowerCase();
  const shared = new Set(pool.filter((r) => r.mine && r.email === key).map((r) => String(r.team_id)));
  const write = (next: Set<string>) => setAccountShares(deviceId, email, [...next]);
  return (
    <div className="flex shrink-0 gap-1.5" data-account-pool-pill={key}>
      <TeamSharePills
        teams={teams}
        shared={shared}
        onOpen={(t: ShareTeam) => {
          write(new Set([...shared, String(t._id)]));
          toast.success(`${email} is in ${t.name}'s pool`, { description: "Teammates' machines get it within a minute." });
        }}
        onClose={(t: ShareTeam) => {
          const next = new Set(shared);
          next.delete(String(t._id));
          write(next);
          toast(`${email} left ${t.name}'s pool`, { description: "Its copies are deleted and sessions move off it within a minute." });
        }}
        confirm={{
          title: (t) => <>Put {email} in {t.name}&apos;s pool?</>,
          description: "Every teammate's machines can then run on it, and auto-switch picks it by headroom.",
          points: [
            "Teammates' sessions spend this account's windows. Settings › Account pool shows who spent what.",
            "Each of their machines gets a sealed copy of its setup-token. Anyone with a shell on one can copy the token while it is valid.",
            "Take it back with one press: codecast's copies are deleted and sessions move off it within a minute.",
          ],
          confirmLabel: (t) => `Share with ${t.name}`,
        }}
      />
    </div>
  );
}
