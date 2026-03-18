import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Button } from "../../../components/ui/button";
import { Logo } from "../../../components/Logo";

export default function JoinTeamPage() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();

  const teamInfo = useQuery(
    api.teams.getTeamByInviteCode,
    code ? { invite_code: code } : "skip"
  );

  const currentUser = useQuery(api.users.getCurrentUser);
  const joinTeam = useMutation(api.teams.joinTeam);

  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  const isAlreadyMember = currentUser?.team_id?.toString() === teamInfo?._id.toString();

  const handleSignInRedirect = () => {
    router.push(`/login?return_to=/join/${code}`);
  };

  const handleJoinTeam = async () => {
    if (!currentUser?._id) return;

    setJoining(true);
    setError("");

    try {
      await joinTeam({
        invite_code: code,
        user_id: currentUser._id,
      });
      router.push("/inbox");
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

  if (!code) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-sol-text">Invalid invite link</h1>
        </div>
      </main>
    );
  }

  if (authLoading || teamInfo === undefined) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="text-sol-text-muted">Loading...</div>
      </main>
    );
  }

  if (!teamInfo) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl text-center">
            <h1 className="text-2xl font-semibold text-sol-text mb-2">Team not found</h1>
            <p className="text-sol-text-muted mb-6">
              This invite link is invalid or has been removed.
            </p>
            <Button
              onClick={() => router.push("/inbox")}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              Go to Inbox
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (teamInfo.isExpired) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl text-center">
            <h1 className="text-2xl font-semibold text-sol-text mb-2">Invite link expired</h1>
            <p className="text-sol-text-muted mb-2">
              This invite link for <span className="font-semibold text-sol-text">{teamInfo.name}</span> has expired.
            </p>
            <p className="text-sol-text-muted text-sm mb-6">
              Please ask the team admin for a new invite link.
            </p>
            <Button
              onClick={() => router.push("/inbox")}
              className="bg-amber-600 hover:bg-amber-500 text-white"
            >
              Go to Inbox
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (isAlreadyMember) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl text-center">
            <div className="mb-6">
              <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-2xl font-semibold text-sol-text mb-2">You&apos;re already a member</h1>
              <p className="text-sol-text-muted">
                You&apos;re already part of <span className="font-semibold text-sol-text">{teamInfo.name}</span>
              </p>
            </div>
            <Button
              onClick={() => router.push("/dashboard")}
              className="w-full bg-amber-600 hover:bg-amber-500 text-white"
            >
              Go to Dashboard
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8 flex flex-col items-center">
            <Logo size="xl" className="text-sol-text" />
          </div>

          <div className="bg-sol-bg-alt backdrop-blur-sm border border-sol-border rounded-xl p-8 shadow-xl">
            <div className="text-center mb-6">
              <h2 className="text-2xl font-semibold text-sol-text mb-2">
                Join {teamInfo.name}
              </h2>
              <p className="text-sol-text-muted">
                {teamInfo.memberCount} {teamInfo.memberCount === 1 ? 'member' : 'members'}
              </p>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-sol-text-muted text-center">
                Sign in to join this team and start collaborating
              </p>

              <Button
                onClick={handleSignInRedirect}
                className="w-full bg-amber-600 hover:bg-amber-500 text-white"
              >
                Sign In to Join
              </Button>

              <p className="text-center text-sm text-sol-text-muted">
                Don&apos;t have an account?{" "}
                <a
                  href={`/signup?return_to=/join/${code}`}
                  className="text-amber-400 hover:text-amber-300 font-medium transition-colors"
                >
                  Sign Up
                </a>
              </p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-sol-bg via-sol-bg-alt to-sol-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-sol-text tracking-tight">
            codecast
          </h1>
        </div>

        <div className="bg-sol-bg-alt/50 backdrop-blur border border-sol-border rounded-xl p-8 shadow-2xl">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-semibold text-sol-text mb-2">
              Join {teamInfo.name}
            </h2>
            <p className="text-sol-text-muted">
              {teamInfo.memberCount} {teamInfo.memberCount === 1 ? 'member' : 'members'}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-400 text-center">{error}</p>
            </div>
          )}

          <Button
            onClick={handleJoinTeam}
            disabled={joining}
            className="w-full bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white"
          >
            {joining ? "Joining..." : "Join Team"}
          </Button>

          <p className="mt-4 text-center text-sm text-sol-text-muted">
            By joining, you&apos;ll have access to team conversations and shared resources.
          </p>
        </div>
      </div>
    </main>
  );
}
