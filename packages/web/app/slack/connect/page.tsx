"use client";

// Where Slack sends the browser back after "Add to Slack". One page completes
// every install — the anchor's and a chat mirror's alike — because Slack allows
// one redirect URI per authorize call and the state already says where the
// person started. The exchange runs here, in the signed-in session, so the
// install binds to the completer's own team (slack.ts explains the relay
// defence); then the page hands the person back to `return_to` with a
// ?slack=connected|error flag the origin surface knows how to show.

import { useAction } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { SlackLogo } from "../../../components/SlackLogo";
import { useMountEffect } from "../../../hooks/useMountEffect";

const ERRORS: Record<string, string> = {
  bad_state: "The link from Slack had expired or was altered. Start again from the page you came from.",
  wrong_user: "This install was started by a different codecast account. Sign in as that account and try again.",
  not_admin: "Only a team admin can connect Slack for the team.",
  no_anchor: "Create your anchor first, then connect Slack.",
  workspace_taken: "That Slack workspace is already connected to a different codecast team.",
  not_configured: "Slack is not configured on this server.",
  access_denied: "Slack reported that the install was cancelled.",
  exchange_failed: "Slack did not accept the install. Try again.",
};

export default function SlackConnectPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <Completion />
      </DashboardLayout>
    </AuthGuard>
  );
}

function Completion() {
  const complete = useAction(api.slack.completeSlackInstall);
  const router = useRouter();
  const [failure, setFailure] = useState<{ code: string; returnTo: string } | null>(null);

  useMountEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const state = p.get("state");
    const denied = p.get("error");
    // Always rebuilt from pathname + search + hash on THIS origin, so a
    // return_to can never carry the browser to another host.
    const samePage = (to: string) => {
      const u = new URL(to, window.location.origin);
      return u.origin === window.location.origin ? u.pathname + u.search + u.hash : "/anchor";
    };
    const withFlag = (to: string, flag: "connected" | "error", reason?: string) => {
      const u = new URL(samePage(to), window.location.origin);
      u.searchParams.set("slack", flag);
      if (reason) u.searchParams.set("reason", reason);
      return u.pathname + u.search + u.hash;
    };
    if (denied || !code || !state) {
      setFailure({ code: denied || "bad_state", returnTo: "/anchor" });
      return;
    }
    complete({ code, state } as any)
      .then((res: any) => {
        const to = typeof res?.return_to === "string" ? res.return_to : "/anchor";
        if (res?.ok) {
          router.replace(withFlag(to, "connected"));
        } else {
          setFailure({ code: String(res?.error ?? "exchange_failed"), returnTo: samePage(to) });
        }
      })
      .catch(() => setFailure({ code: "exchange_failed", returnTo: "/anchor" }));
  });

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 w-10 h-10 grid place-items-center rounded-xl border border-sol-border bg-sol-bg-alt/40">
          <SlackLogo className="w-5 h-5" muted={!!failure} />
        </div>
        {failure ? (
          <>
            <h1 className="text-sm font-semibold text-sol-text">Slack was not connected</h1>
            <p className="mt-2 text-xs leading-relaxed text-sol-text-muted">
              {ERRORS[failure.code] ?? `Slack answered: ${failure.code}`}
            </p>
            <button
              type="button"
              onClick={() => router.replace(failure.returnTo)}
              className="mt-5 text-xs px-3 py-1.5 rounded-md border border-sol-border text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            >
              Go back
            </button>
          </>
        ) : (
          <>
            <h1 className="text-sm font-semibold text-sol-text">Connecting Slack</h1>
            <p className="mt-2 text-xs text-sol-text-muted">Finishing the install with your workspace.</p>
          </>
        )}
      </div>
    </div>
  );
}
