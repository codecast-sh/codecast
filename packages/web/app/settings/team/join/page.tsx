import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Input } from "../../../../components/ui/input";
import { Button } from "../../../../components/ui/button";
import { Label } from "../../../../components/ui/label";
import { TeamFlowShell, type TeamFlowStep } from "../../../../components/team/TeamFlowShell";
import { useCurrentUser } from "../../../../hooks/useCurrentUser";

const CODE_FORM_ID = "team-join-code";
const CODE_LENGTH = 8;

// Only the first step lives here. Joining hands off to the setup dialog for
// visibility and workspaces, as before; the rail shows what comes next.
const STEPS: TeamFlowStep[] = [
  { key: "code", label: "Invite code" },
  { key: "visibility", label: "Visibility" },
  { key: "workspaces", label: "Workspaces" },
];

export default function JoinTeamPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const joinTeam = useMutation(api.teams.joinTeam);

  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  const goBack = useCallback(() => router.push("/settings/team"), [router]);

  const handleJoinTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inviteCode.length !== CODE_LENGTH || !user?._id) return;
    setJoining(true);
    setError("");
    try {
      const teamId = await joinTeam({
        invite_code: inviteCode.trim().toUpperCase(),
        user_id: user._id,
      });
      router.push(`/settings/sync?teamSetup=1&teamId=${teamId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the team. Try again.");
    } finally {
      setJoining(false);
    }
  };

  const handlePasteLink = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const match = text.match(/\/join\/([A-Z0-9]+)/i);
      if (match) {
        setInviteCode(match[1].toUpperCase());
      } else if (/^[A-Z0-9]{8}$/i.test(text.trim())) {
        setInviteCode(text.trim().toUpperCase());
      }
    } catch {
      // Clipboard access denied
    }
  };

  return (
    <TeamFlowShell
      eyebrow="Join a team"
      steps={STEPS}
      stepIndex={0}
      crest={{ name: "Your team" }}
      heading="Enter the invite code"
      description="Type the 8 character code or paste the invite link."
      onBack={goBack}
      backLabel="Cancel"
      formId={CODE_FORM_ID}
      continueLabel={joining ? "Joining" : "Join team"}
      continueDisabled={inviteCode.length !== CODE_LENGTH || joining || !user}
    >
      <form id={CODE_FORM_ID} onSubmit={handleJoinTeam} className="space-y-5">
        <div>
          <Label htmlFor="inviteCode" className="text-sol-text">Invite code</Label>
          <div className="flex gap-2 mt-1.5">
            <Input
              id="inviteCode"
              value={inviteCode}
              onChange={(e) => { setInviteCode(e.target.value.toUpperCase()); if (error) setError(""); }}
              placeholder="ABCD1234"
              className="h-11 text-base bg-sol-bg-alt border-sol-border text-sol-text font-mono uppercase tracking-[0.2em] focus-visible:ring-[var(--team-flow-accent)]"
              maxLength={CODE_LENGTH}
              autoFocus
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handlePasteLink}
              className="h-11 border-sol-border text-sol-text-dim shrink-0"
            >
              Paste
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-sol-text-dim">
            Ask a team admin for the code or link.
          </p>
        </div>

        {error && (
          <div role="alert" className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
            <p className="text-sm text-sol-red">{error}</p>
          </div>
        )}
      </form>
    </TeamFlowShell>
  );
}
