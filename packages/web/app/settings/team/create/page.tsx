"use client";

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

export default function CreateTeamPage() {
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);
  const createTeam = useMutation(api.teams.createTeam);

  const [teamName, setTeamName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  if (!user) {
    return null;
  }

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim() || !user._id) return;

    setCreating(true);
    setError("");

    try {
      await createTeam({
        name: teamName.trim(),
        user_id: user._id,
      });
      router.push("/settings/team");
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to create team. Please try again.");
      }
    } finally {
      setCreating(false);
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
        <h1 className="text-xl font-semibold text-sol-text">Create a New Team</h1>
      </div>

      <Card className="p-6 bg-sol-bg border-sol-border max-w-md">
        <form onSubmit={handleCreateTeam} className="space-y-4">
          <div>
            <Label htmlFor="teamName" className="text-sol-text">Team Name</Label>
            <Input
              id="teamName"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="My Team"
              className="mt-1.5 bg-sol-bg-alt border-sol-border text-sol-text"
              autoFocus
            />
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
              disabled={!teamName.trim() || creating}
              className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
            >
              {creating ? "Creating..." : "Create Team"}
            </Button>
          </div>
        </form>

        <p className="mt-4 text-xs text-sol-base1">
          After creating your team, you can invite members using an invite link.
        </p>
      </Card>
    </div>
  );
}
