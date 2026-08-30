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
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";
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
  const { data: team, error: teamError, retry: retryTeam } = useQueryNoThrow(api.teams.getTeam, { team_id: teamId });
  const regenerateInviteCode = useMutation(api.teams.regenerateInviteCode);
  const sendInviteEmail = useMutation(api.teams.sendInviteEmail);

  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });

  const inviteUrl = team?.invite_code ? `https://codecast.sh/join/${team.invite_code}` : "";
  const isExpired = !!(team?.invite_code_expires_at && Date.now() > team.invite_code_expires_at);
  const isAdmin = teamRole ? teamRole === "admin" : user?.role === "admin";
  const page = variant === "page";

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await copyToClipboard(inviteUrl);
    } catch {
      // Both clipboard paths failed (permissions, focus). Never fail the
      // payoff action silently: select the link so one copy chord finishes
      // the job, and say so next to the field.
      setCopyFailed(true);
      document.getElementById("team-invite-link")?.focus();
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerate = async () => {
    if (!user?._id) return;
    setIsRegenerating(true);
    setRegenError(false);
    try {
      await regenerateInviteCode({ team_id: teamId, requesting_user_id: user._id });
    } catch {
      // The old link keeps working on failure, so the message only has to
      // say the new one did not happen.
      setRegenError(true);
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
          <Label htmlFor="team-invite-link" className="text-sol-text">Invite link</Label>
          <span className="flex items-center gap-2 text-xs">
            {/* aria-live: after New link runs, the fresh expiry is the only
                text that changes, so announcing it confirms the action. */}
            <span aria-live="polite" className={isExpired ? "text-sol-red" : "text-sol-text-muted"}>
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
                  // The accessible name stays the visible label, so voice
                  // control can target it. The consequence rides along as a
                  // description instead of replacing the name.
                  aria-describedby="team-invite-regen-note"
                  className="tf-ghost -my-0.5 rounded px-1 py-0.5 text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]"
                >
                  {isRegenerating ? "Making a new link" : "New link"}
                </button>
                <span id="team-invite-regen-note" className="sr-only">
                  Makes a new invite link that lasts 7 days. The old one stops working.
                </span>
              </>
            )}
          </span>
        </div>
        {teamError && !team ? (
          // The link never arrived (offline, server error). Say so and offer
          // one retry; the email form below still works without it.
          <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-sol-red/20 bg-sol-red/10 px-3 py-2.5">
            <p className="text-sm text-sol-red">Could not load the invite link.</p>
            <button
              type="button"
              onClick={retryTeam}
              className="tf-ghost shrink-0 rounded px-1 py-0.5 text-sm text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]"
            >
              Try again
            </button>
          </div>
        ) : (
        <div className="flex gap-2">
          <Input
            id="team-invite-link"
            value={inviteUrl}
            readOnly
            // Focus selects the whole link, so a keyboard user can copy it
            // with one chord instead of selecting a long URL by hand.
            onFocus={(e) => e.currentTarget.select()}
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
        )}
        {/* Persistent for the same reason as the send status below. */}
        <p aria-live="polite" className={copyFailed ? "text-sm text-sol-red" : "sr-only"}>
          {copyFailed && (
            <>
              Could not copy. The link is selected; press{" "}
              <span className="inline-flex items-center gap-0.5">
                <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
                <KeyCap size="xs">C</KeyCap>
              </span>{" "}
              to copy it.
            </>
          )}
        </p>
        <p aria-live="polite" className={regenError ? "text-sm text-sol-red" : "sr-only"}>
          {regenError && "Could not make a new link. The current one still works."}
        </p>
        {isExpired && (
          <p className="text-sm text-sol-red">
            This invite link has expired. {isAdmin ? "Use New link above to make a fresh one." : "Ask an admin to make a new one."}
          </p>
        )}
      </div>

      <div className="pt-3 border-t border-sol-border space-y-2">
        <Label htmlFor="team-invite-email" className="text-sol-text">Or email an invite</Label>
        <form onSubmit={handleSendEmail} className="flex gap-2">
          <Input
            id="team-invite-email"
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
            className={`${page ? "h-11 px-5" : ""} border-sol-border text-sol-text-muted hover:bg-sol-bg-alt`}
          >
            {sendState.kind === "sending" ? "Sending" : "Send"}
          </Button>
        </form>
        {/* One persistent live region: a region inserted together with its
            text is often not announced, so the container stays mounted and
            only the message swaps. sr-only while empty keeps the layout
            unchanged without dropping it from the accessibility tree. */}
        <p
          aria-live="polite"
          className={
            sendState.kind === "sent" || sendState.kind === "error"
              ? `text-sm ${sendState.kind === "error" ? "text-sol-red" : "text-sol-green"}`
              : "sr-only"
          }
        >
          {sendState.kind === "sent" && (
            <span className="tf-pop inline-flex items-center gap-1.5">
              <Check className="w-4 h-4" />
              Invite sent to {sendState.to}
            </span>
          )}
          {sendState.kind === "error" && sendState.message}
        </p>
      </div>

      {/* One quiet line, closed by default: the panel reads link, email,
          done, and the finish action stays in view. */}
      <details className="group pt-3 border-t border-sol-border">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-sm text-sol-text-muted hover:text-sol-text [&::-webkit-details-marker]:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]">
          <ChevronRight className="w-3.5 h-3.5 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden="true" />
          How invites work
        </summary>
        <ol className="mt-2.5 text-sm text-sol-text-muted space-y-2.5">
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
