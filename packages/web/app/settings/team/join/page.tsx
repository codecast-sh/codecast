import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Button } from "../../../../components/ui/button";
import { Label } from "../../../../components/ui/label";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function JoinTeamPage() {
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);
  const joinTeam = useMutation(api.teams.joinTeam);

  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  if (!user) {
    return null;
  }

  const handleJoinTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim() || !user._id) return;

    setJoining(true);
    setError("");

    try {
      await joinTeam({
        invite_code: inviteCode.trim().toUpperCase(),
        user_id: user._id,
      });
      router.push("/settings/team");
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to join team. Please try again.");
      }
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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/settings/team"
          className="p-2 text-sol-base1 hover:text-sol-text rounded-lg hover:bg-sol-base02/50 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-semibold text-sol-text">Join a Team</h1>
      </div>

      <Card className="p-6 bg-sol-bg border-sol-border max-w-md">
        <form onSubmit={handleJoinTeam} className="space-y-4">
          <div>
            <Label htmlFor="inviteCode" className="text-sol-text">Invite Code</Label>
            <div className="flex gap-2 mt-1.5">
              <Input
                id="inviteCode"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="ABCD1234"
                className="bg-sol-bg-alt border-sol-border text-sol-text font-mono uppercase"
                maxLength={8}
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                onClick={handlePasteLink}
                className="border-sol-border text-sol-base1 shrink-0"
              >
                Paste
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-sol-base1">
              Enter the 8-character invite code or paste an invite link
            </p>
          </div>

          {error && (
            <div className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
              <p className="text-sm text-sol-red">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              className="border-sol-border text-sol-base1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={inviteCode.length !== 8 || joining}
              className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
            >
              {joining ? "Joining..." : "Join Team"}
            </Button>
          </div>
        </form>

        <p className="mt-4 text-xs text-sol-base1">
          Ask your team admin for an invite code or link to join their team.
        </p>
      </Card>
    </div>
  );
}
