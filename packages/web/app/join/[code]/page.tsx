import { useState, type CSSProperties, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, Users } from "lucide-react";
import { Logo } from "../../../components/Logo";
import { AppLoader } from "../../../components/AppLoader";
import { TeamCrest } from "../../../components/team/TeamCrest";
import { adoptPathIntoActiveTab } from "../../../src/compat/tabRouting";
import { useSwitchWorkspace } from "../../../hooks/useSwitchWorkspace";
import "../../../components/team/teamFlow.css";

/**
 * Public invite landing. Pre-auth, so it cannot use the four step flow
 * shell, but it is styled as its sibling: the team crest is the hero and
 * the crest color is the surface accent through --team-flow-accent.
 */

/** Centered card with the accent wash pooling behind the crest. */
function JoinShell({
  color,
  children,
}: {
  color?: string | null;
  children: ReactNode;
}) {
  const style = (color
    ? { "--team-flow-accent": `var(--sol-${color})` }
    : undefined) as CSSProperties | undefined;
  return (
    <main
      style={style}
      className="tf-root min-h-screen bg-sol-bg flex items-center justify-center px-4 py-10"
    >
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-[24rem] transition-colors duration-500"
        style={{
          background:
            "radial-gradient(34rem 16rem at 50% 0%, color-mix(in srgb, var(--team-flow-accent, var(--sol-cyan)) 22%, transparent), transparent 75%)",
        }}
      />
      <div className="relative w-full max-w-sm">
        <div className="tf-reveal mb-8 flex justify-center" style={{ "--tf-i": 0 } as CSSProperties}>
          <Logo size="lg" className="text-sol-text" />
        </div>
        <div className="rounded-2xl border border-sol-border bg-sol-bg-alt/60 p-8 shadow-xl backdrop-blur">
          {children}
        </div>
      </div>
    </main>
  );
}

/** Crest, eyebrow line and team name — the header every state shares. */
function JoinHeader({
  eyebrow,
  icon,
  color,
  name,
  memberCount,
}: {
  eyebrow: string;
  icon?: string | null;
  color?: string | null;
  name: string;
  memberCount?: number;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="tf-reveal" style={{ "--tf-i": 1 } as CSSProperties}>
        <TeamCrest icon={icon} color={color} size="lg" className="tf-crest" />
      </div>
      <p
        className="tf-eyebrow tf-reveal mt-5 text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ "--tf-i": 2 } as CSSProperties}
      >
        {eyebrow}
      </p>
      <h1
        className="tf-reveal mt-1 text-2xl font-semibold text-sol-text"
        style={{ "--tf-i": 3 } as CSSProperties}
      >
        {name}
      </h1>
      {memberCount !== undefined && (
        <p
          className="tf-reveal mt-1.5 flex items-center gap-1.5 text-sm text-sol-text-muted"
          style={{ "--tf-i": 4 } as CSSProperties}
        >
          <Users className="h-3.5 w-3.5" />
          {memberCount} {memberCount === 1 ? "member" : "members"}
        </p>
      )}
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="tf-primary tf-reveal inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium disabled:pointer-events-none disabled:opacity-50"
      style={{ "--tf-i": 5 } as CSSProperties}
    >
      {children}
    </button>
  );
}

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
  const switchWorkspace = useSwitchWorkspace();

  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  const isAlreadyMember = currentUser?.team_id?.toString() === teamInfo?._id.toString();

  const goTo = (path: string) => {
    adoptPathIntoActiveTab(path);
    router.push(path);
  };

  const handleJoinTeam = async () => {
    if (!currentUser?._id) return;
    setJoining(true);
    setError("");
    try {
      const teamId = await joinTeam({ invite_code: code });
      // Joining IS the switch; the guided flow then tunes the new team.
      void switchWorkspace(teamId);
      goTo(`/settings/team/join?teamId=${teamId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the team. Try again.");
    } finally {
      setJoining(false);
    }
  };

  if (authLoading || (code && teamInfo === undefined)) {
    return <AppLoader className="bg-sol-bg px-4" />;
  }

  if (!code || !teamInfo) {
    return (
      <JoinShell>
        <JoinHeader eyebrow="Team invite" name="Invite not found" />
        <p
          className="tf-reveal mt-3 text-center text-sm text-sol-text-muted"
          style={{ "--tf-i": 4 } as CSSProperties}
        >
          This invite link is invalid or was removed. Ask a team admin for a new one.
        </p>
        <div className="mt-6">
          <PrimaryButton onClick={() => goTo("/inbox")}>Open codecast</PrimaryButton>
        </div>
      </JoinShell>
    );
  }

  if (teamInfo.isExpired) {
    return (
      <JoinShell color={teamInfo.icon_color}>
        <JoinHeader
          eyebrow="Invite expired"
          icon={teamInfo.icon}
          color={teamInfo.icon_color}
          name={teamInfo.name}
        />
        <p
          className="tf-reveal mt-3 text-center text-sm text-sol-text-muted"
          style={{ "--tf-i": 4 } as CSSProperties}
        >
          This invite link has expired. Ask a team admin for a new one.
        </p>
        <div className="mt-6">
          <PrimaryButton onClick={() => goTo("/inbox")}>Open codecast</PrimaryButton>
        </div>
      </JoinShell>
    );
  }

  if (isAlreadyMember) {
    return (
      <JoinShell color={teamInfo.icon_color}>
        <JoinHeader
          eyebrow="Already a member"
          icon={teamInfo.icon}
          color={teamInfo.icon_color}
          name={teamInfo.name}
          memberCount={teamInfo.memberCount}
        />
        <p
          className="tf-reveal mt-3 flex items-center justify-center gap-1.5 text-center text-sm text-sol-green"
          style={{ "--tf-i": 4 } as CSSProperties}
        >
          <Check className="h-4 w-4" />
          You are on this team
        </p>
        <div className="mt-6">
          <PrimaryButton onClick={() => goTo("/team/activity")}>Open the team</PrimaryButton>
        </div>
      </JoinShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <JoinShell color={teamInfo.icon_color}>
        <JoinHeader
          eyebrow="You're invited to join"
          icon={teamInfo.icon}
          color={teamInfo.icon_color}
          name={teamInfo.name}
          memberCount={teamInfo.memberCount}
        />
        <div className="mt-6">
          <PrimaryButton onClick={() => router.push(`/login?return_to=/join/${code}`)}>
            Sign in to join
          </PrimaryButton>
        </div>
        <p
          className="tf-reveal mt-4 text-center text-sm text-sol-text-muted"
          style={{ "--tf-i": 6 } as CSSProperties}
        >
          New here?{" "}
          <a
            href={`/signup?return_to=/join/${code}`}
            className="font-medium text-sol-text underline-offset-4 hover:underline"
          >
            Create an account
          </a>
        </p>
      </JoinShell>
    );
  }

  return (
    <JoinShell color={teamInfo.icon_color}>
      <JoinHeader
        eyebrow="You're invited to join"
        icon={teamInfo.icon}
        color={teamInfo.icon_color}
        name={teamInfo.name}
        memberCount={teamInfo.memberCount}
      />
      {error && (
        <div className="mt-4 rounded-lg bg-sol-red/10 p-3">
          <p className="text-center text-sm text-sol-red">{error}</p>
        </div>
      )}
      <div className="mt-6">
        <PrimaryButton onClick={handleJoinTeam} disabled={joining}>
          {joining ? "Joining" : `Join ${teamInfo.name}`}
        </PrimaryButton>
      </div>
      <p
        className="tf-reveal mt-4 text-center text-xs text-sol-text-dim"
        style={{ "--tf-i": 6 } as CSSProperties}
      >
        Joining gives you access to this team's shared sessions and chat.
      </p>
    </JoinShell>
  );
}
