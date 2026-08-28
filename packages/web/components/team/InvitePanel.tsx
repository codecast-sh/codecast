import { useState } from "react";
import { Check, ChevronRight } from "lucide-react";
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
import "./teamFlow.css";

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
    <div className={`tf-accent-scope ${page ? "space-y-6" : "space-y-4 py-4"}`}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sol-base1">Invite link</Label>
          <span className="flex items-center gap-2 text-xs">
            <span className={isExpired ? "text-sol-red" : "text-sol-base1"}>
              {team ? formatInviteExpiry(team.invite_code_expires_at) : ""}
            </span>
            {/* Regenerate is a quiet text action next to the expiry it
                changes, so the panel keeps one accent action: Copy. */}
            {isAdmin && (
              <>
                <span aria-hidden="true" className="text-sol-border">·</span>
                <button
                  type="button"
                  onClick={handleRegenerate}
                  disabled={isRegenerating || !team}
                  aria-label="Make a new invite link. It lasts 7 days and the old one stops working."
                  className="tf-ghost -my-0.5 rounded px-1 py-0.5 text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]"
                >
                  {isRegenerating ? "Making a new link" : "New link"}
                </button>
              </>
            )}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            value={inviteUrl}
            readOnly
            placeholder={team ? "" : "Making your invite link"}
            className={`font-mono ${page ? "text-base h-11" : "text-sm"} bg-sol-bg-alt border-sol-border text-sol-text ${isExpired ? "opacity-50" : ""}`}
          />
          {/* Copy is the payoff action, so it carries the accent. The
              confirmation swaps in a check with a quick pop. */}
          <Button
            onClick={handleCopy}
            disabled={isExpired || !inviteUrl}
            aria-live="polite"
            className={`tf-primary ${page ? "h-11 px-5" : ""}`}
          >
            {copied ? (
              <span className="tf-pop inline-flex items-center gap-1.5">
                <Check className="w-4 h-4" />
                Copied
              </span>
            ) : (
              "Copy"
            )}
          </Button>
        </div>
        {isExpired && (
          <p className="text-sm text-sol-red">
            This invite link has expired. {isAdmin ? "Use New link above to make a fresh one." : "Ask an admin to make a new one."}
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
          <p className="tf-pop flex items-center gap-1.5 text-sm text-sol-green" aria-live="polite">
            <Check className="w-4 h-4" />
            Invite sent to {sendState.to}
          </p>
        )}
        {sendState.kind === "error" && (
          <p className="text-sm text-sol-red" aria-live="polite">{sendState.message}</p>
        )}
      </div>

      {/* One quiet line, closed by default: the panel reads link, email,
          done, and the finish action stays in view. */}
      <details className="group pt-3 border-t border-sol-border">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-sm text-sol-base1 hover:text-sol-text [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]">
          <ChevronRight className="w-3.5 h-3.5 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden="true" />
          How invites work
        </summary>
        <ol className="mt-2.5 text-sm text-sol-base1 space-y-2.5">
          {[
            "Send the link to a teammate.",
            "They open it, sign in, and land on this team.",
            "They install the CLI and their sessions show in the team feed.",
          ].map((line, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="tf-how-num flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
                {i + 1}
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
