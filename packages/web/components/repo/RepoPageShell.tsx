// The frame every repository, commit and pull request page sits in.
//
// There are two of them and a page must not care which it got. The app form is
// the dashboard: sidebar, tab bar, and the sign in gate in front of all of it.
// The standalone form is the whole window: a slim strip naming the repository,
// then the page, and no gate at all, so a public repository is readable by
// somebody who has never signed in. Signed in or not, the page underneath is
// the same component reading the same store.
import type { ReactNode } from "react";
import Link from "next/link";
import { AuthGuard } from "../AuthGuard";
import { DashboardLayout } from "../DashboardLayout";
import { LogoMark } from "../Logo";
import { useLocalAuth } from "../../lib/localAuth";
import { useRepoFamily } from "./useRepoFamily";
import { useRepoAccess } from "../../hooks/useRepoAccess";
import { RepoTransportProvider, publicRepoUrl, usePublicRepoRead } from "../../lib/repoTransport";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "../../hooks/useSyncCollection";
import { useIsSyncHost } from "../../hooks/useSyncRole";

/**
 * The strip is 36px, and the page below it owns the rest of the viewport. The
 * way back into the app is NOT here: every page header carries a
 * RepoWindowControl in its own slot, and two links saying the same thing on
 * one screen is one too many.
 */
function StandaloneRepoShell({ repository, children }: { repository: string; children: ReactNode }) {
  const signedIn = useLocalAuth();
  const [owner, name] = repository.split("/");

  return (
    <div className="h-screen flex flex-col bg-sol-bg text-sol-text">
      <header className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-sol-border/60 bg-sol-bg-alt/40">
        <Link
          href={signedIn ? "/repo" : "/"}
          className="flex items-center gap-1.5 text-sol-text-muted hover:text-sol-text transition-colors"
          title="Codecast"
        >
          <LogoMark size={16} monochrome />
          <span className="text-[12px]">codecast</span>
        </Link>
        <span className="text-sol-text-dim">/</span>
        <span className="min-w-0 mr-auto text-[12px] text-sol-text-muted truncate">
          {owner}
          <span className="text-sol-text-dim">/</span>
          <span className="text-sol-text">{name}</span>
        </span>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

export function RepoPageShell({ repository, children }: { repository: string; children: ReactNode }) {
  const family = useRepoFamily();
  const signedIn = useLocalAuth();
  const { isAuthenticated } = useConvexAuth();
  const isHost = useIsSyncHost();
  useSyncCollection("currentUser", api.users.getCurrentUser, family === "standalone" && isHost && isAuthenticated ? {} : "skip");
  const access = useRepoAccess(repository, signedIn);
  const mode = access.allowed === true ? "convex" : "public";
  const publicMeta = usePublicRepoRead<{ private: boolean }>(family === "standalone" && mode === "public"
    ? publicRepoUrl(repository, "meta", {}) : null);

  if (family === "standalone") {
    if (mode === "public" && publicMeta.data?.private !== false) {
      if (!publicMeta.ready) return <div className="h-screen bg-sol-bg"><LoadingSkeleton /></div>;
      return <RepoUnavailable />;
    }
    return <RepoTransportProvider mode={mode}><StandaloneRepoShell repository={repository}>{children}</StandaloneRepoShell></RepoTransportProvider>;
  }

  return (
    <AuthGuard>
      <DashboardLayout>
        <RepoTransportProvider mode="convex"><div className="h-[calc(100vh-56px)]">
          {access.allowed === false ? <RepoUnavailable /> : children}
        </div></RepoTransportProvider>
      </DashboardLayout>
    </AuthGuard>
  );
}

function RepoUnavailable() {
  return <main className="min-h-full flex flex-col items-center justify-center bg-sol-bg text-sol-text gap-4 px-6 py-16">
    <LogoMark size={24} monochrome />
    <h1 className="font-serif text-2xl">Repository unavailable</h1>
    <p className="text-sm text-sol-text-muted">Sign in with an account that has access to continue.</p>
    <Link href="/login" className="rounded border border-sol-border px-4 py-2 text-sm text-sol-blue">Sign in</Link>
  </main>;
}
