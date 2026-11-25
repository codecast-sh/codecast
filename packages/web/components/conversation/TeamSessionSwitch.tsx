"use client";

// Personal or Team, chosen before a new session starts (team sessions spec).
// Personal: it is yours, as every session is today. Team: the team owns it,
// so it sits in everyone's inbox and anyone on the team answers it. The pick
// is local to the not-yet-started session (setStubTeam) until the first send
// folds it into the create (createSessionFromStub → createSession `team`).
//
// It names the team the session will land on, which its folder decides
// (sessionVisibilityPreview.creationTeam, the resolve createSession runs), and
// shows only where that team has Team sessions on, so Team never quietly fails.
import { Users } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { OwnerAvatar } from "../OwnersBadge";

export function TeamSessionSwitch({ conversationId }: { conversationId: string }) {
  const sig = useInboxStore((s) => {
    const row: any = (s.sessions as any)?.[conversationId] ?? (s.conversations as any)?.[conversationId];
    const me: any = s.currentUser;
    return [row?._team === "team" ? "team" : "personal", row?.git_root || row?.project_path || "", me?.name ?? me?.email ?? "", me?.image ?? me?.github_avatar_url ?? ""].join("\u0001");
  });
  const setStubTeam = useInboxStore((s) => s.setStubTeam);
  const [pick, path, myName, myImage] = sig.split("\u0001");
  const destination = useQueryNoThrow(api.sessionVisibilityPreview.creationTeam, { path: path || undefined }).data;
  if (!destination?.team_sessions) return null;
  const team = pick === "team";
  const seg = (active: boolean) =>
    `px-2 py-0.5 rounded-full text-meta font-medium transition-colors ${active ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text"}`;
  return (
    <span data-team-session-switch={pick} className="ml-2 inline-flex items-center gap-2">
      <span role="radiogroup" aria-label="Who this session is for" className="inline-flex items-center rounded-full bg-sol-bg-alt p-0.5 border border-sol-border/40">
        <button type="button" role="radio" aria-checked={!team} onClick={() => setStubTeam(conversationId, "mine")} className={seg(!team)}>Personal</button>
        <button type="button" role="radio" aria-checked={team} onClick={() => setStubTeam(conversationId, "team")} className={seg(team)}>Team</button>
      </span>
      <span className="inline-flex items-center gap-1.5 text-meta text-sol-text-dim">
        {team ? (
          <><span className="w-4 h-4 rounded-full bg-sol-violet/15 text-sol-violet flex items-center justify-center"><Users className="w-2.5 h-2.5" /></span>Everyone on {destination.team_name}</>
        ) : (
          <><OwnerAvatar name={myName || "You"} image={myImage || undefined} />Yours</>
        )}
      </span>
    </span>
  );
}
