import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useTrackedStore } from "../../store/inboxStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { copyToClipboard } from "../../lib/utils";
import { formatInviteExpiry } from "../../lib/team/inviteExpiry";

export interface InvitePanelProps {
  teamId: Id<"teams">;
  /** "modal" keeps the dialog spacing; "page" is roomier for a full page step. */
  variant?: "modal" | "page";
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; to: string }
  | { kind: "error"; message: string };

function findTeamRole(teams: Array<{ _id?: string; role?: string } | null> | undefined, teamId: string) {
  return teams?.find((t) => t?._id === teamId)?.role;
}

/**
 * Invite link, email invite and regenerate for ONE team. The team identity and
 * the viewer's role come from the store's `teams` list; the invite code is
 * server only, so it comes from `getTeam` as an enrichment (no throw).
 */
export function InvitePanel({ teamId, variant = "modal" }: InvitePanelProps) {
  const { user } = useCurrentUser();
  const teamRole = findTeamRole(useTrackedStore([(s) => findTeamRole(s.teams, teamId)]).teams, teamId);
  const { data: team } = useQueryNoThrow(api.teams.getTeam, { team_id: teamId });
  const regenerateInviteCode = useMutation(api.teams.regenerateInviteCode);
  const sendInviteEmail = useMutation(api.teams.sendInviteEmail);

  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });

  const inviteUrl = team?.invite_code ? `https://codecast.sh/join/${team.invite_code}` : "";
  const isExpired = !!(team?.invite_code_expires_at && Date.now() > team.invite_code_expires_at);
  const isAdmin = teamRole ? teamRole === "admin" : user?.role === "admin";
  const page = variant === "page";

  const handleCopy = async () => {
    if (!inviteUrl) return;
    await copyToClipboard(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerate = async () => {
    if (!user?._id) return;
    setIsRegenerating(true);
    try {
      await regenerateInviteCode({ team_id: teamId, requesting_user_id: user._id });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setSendState({ kind: "sending" });
    try {
      await sendInviteEmail({ team_id: teamId, email });
      setSendState({ kind: "sent", to: email });
      setInviteEmail("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setSendState({
        kind: "error",
        message: msg.includes("Invalid email")
          ? "That does not look like an email address."
          : msg.includes("Too many")
            ? "Too many invites sent this hour. Try again later."
            : "Could not send the invite. Try copying the link instead.",
      });
    }
  };

  return (
    <div className={page ? "space-y-6" : "space-y-4 py-4"}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sol-base1">Invite Link</Label>
          <span className={`text-xs ${isExpired ? "text-sol-red" : "text-sol-base1"}`}>
            {team ? formatInviteExpiry(team.invite_code_expires_at) : ""}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            value={inviteUrl}
            readOnly
            placeholder={team ? "" : "Loading invite link"}
            className={`font-mono ${page ? "text-base h-11" : "text-sm"} bg-sol-bg-alt border-sol-border text-sol-text ${isExpired ? "opacity-50" : ""}`}
          />
          <Button
            onClick={handleCopy}
            variant="outline"
            disabled={isExpired || !inviteUrl}
            aria-live="polite"
            className={`${page ? "h-11 px-5" : ""} ${copied ? "border-sol-green text-sol-green" : "border-sol-border text-sol-base1"} hover:bg-sol-bg-alt`}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {isExpired && (
          <p className="text-sm text-sol-red">
            This invite link has expired. {isAdmin ? "Generate a new one below." : "Ask an admin to regenerate it."}
          </p>
        )}
      </div>

      <div className="pt-3 border-t border-sol-border space-y-2">
        <Label className="text-sol-base1">Or email an invite</Label>
        <form onSubmit={handleSendEmail} className="flex gap-2">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => {
              setInviteEmail(e.target.value);
              if (sendState.kind !== "idle") setSendState({ kind: "idle" });
            }}
            placeholder="teammate@example.com"
            disabled={isExpired || sendState.kind === "sending"}
            className={`${page ? "text-base h-11" : "text-sm"} bg-sol-bg-alt border-sol-border text-sol-text`}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={isExpired || !inviteEmail.trim() || sendState.kind === "sending"}
            className={`${page ? "h-11 px-5" : ""} border-sol-border text-sol-base1 hover:bg-sol-bg-alt`}
          >
            {sendState.kind === "sending" ? "Sending" : "Send"}
          </Button>
        </form>
        {sendState.kind === "sent" && (
          <p className="text-sm text-sol-green" aria-live="polite">Invite sent to {sendState.to}</p>
        )}
        {sendState.kind === "error" && (
          <p className="text-sm text-sol-red" aria-live="polite">{sendState.message}</p>
        )}
      </div>

      <div className="pt-3 border-t border-sol-border">
        <div className="text-sm font-medium text-sol-text mb-2">How it works</div>
        <ol className="text-sm text-sol-base1 space-y-1.5 list-decimal list-inside">
          <li>Share the invite link with your teammate</li>
          <li>They sign in or create an account</li>
          <li>They join the team automatically</li>
          <li>They install the daemon to start syncing conversations</li>
        </ol>
      </div>

      {isAdmin && (
        <div className="pt-2 border-t border-sol-border">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-sol-text">Regenerate Link</div>
              <div className="text-xs text-sol-base1">Creates a new link valid for 7 days</div>
            </div>
            <Button
              onClick={handleRegenerate}
              variant="outline"
              size="sm"
              disabled={isRegenerating || !team}
              className="border-sol-cyan text-sol-cyan hover:bg-sol-cyan/10"
            >
              {isRegenerating ? "Regenerating" : "Regenerate"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
