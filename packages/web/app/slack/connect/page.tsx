"use client";

import { useAction, useConvexAuth } from "convex/react";
import { useNavigate } from "react-router";
import { useCallback, useRef, useState } from "react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { SlackLogo } from "../../../components/SlackLogo";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { canResumeSlackReturn, clearSlackReturn, readSlackReturn, SLACK_SIGN_IN_URL } from "../../../lib/slackReturn";
import { adoptPathIntoActiveTab } from "../../../src/compat/tabRouting";
import { isNonTabRoute } from "../../../lib/tabRoutes";

const ERRORS: Record<string, string> = {
  bad_state: "The link from Slack had expired or was altered. Start again from the page you came from.",
  wrong_user: "This install was started by a different codecast account. Sign in as that account and try again.",
  not_admin: "Only a team admin can connect Slack for the team.",
  no_anchor: "Seat the workspace's agent first, then connect Slack.",
  workspace_taken: "That Slack workspace is already connected to a different codecast team.",
  not_configured: "Slack is not configured on this server.",
  no_workspace: "Connect the team's Slack workspace first; then connect your own account.",
  wrong_workspace: "That is a different Slack workspace from the one this team uses. Sign in to the team's workspace in Slack and try again.",
  no_user_token: "Slack did not grant your account's permissions. Try again and accept the request.",
  access_denied: "Slack reported that the install was cancelled.",
  exchange_failed: "Slack did not accept the install. Try again.",
  invalid_code: "This Slack link has expired or was already used. Start a new connection from Integrations.",
  code_already_used: "This Slack link was already used. Check Integrations before starting another connection.",
  storage_unavailable: "Your browser could not save this connection. Sign in to Codecast in this browser, then start the Slack connection again.",
};

export default function SlackConnectPage() {
  const complete = useAction(api.slack.completeSlackInstall);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const navigate = useNavigate();
  const [pending] = useState(() => readSlackReturn());
  const started = useRef(false);
  const [failure, setFailure] = useState<{ code: string; returnTo: string } | null>(null);
  const returnToApp = useCallback((path: string) => {
    if (!isNonTabRoute(path)) adoptPathIntoActiveTab(path);
    navigate(path, { replace: true });
  }, [navigate]);

  useWatchEffect(() => {
    if (started.current) return;
    if (pending?.error || !pending?.code || !pending.state) {
      started.current = true;
      if (pending) clearSlackReturn(pending);
      setFailure({ code: pending?.error || "bad_state", returnTo: "/settings/integrations" });
      return;
    }
    if (isLoading) return;
    if (!isAuthenticated) {
      started.current = true;
      if (canResumeSlackReturn(pending)) navigate(SLACK_SIGN_IN_URL, { replace: true });
      else {
        clearSlackReturn(pending);
        setFailure({ code: "storage_unavailable", returnTo: "/settings/integrations" });
      }
      return;
    }
    started.current = true;
    const samePage = (to: string) => {
      const u = new URL(to, window.location.origin);
      return u.origin === window.location.origin ? u.pathname + u.search + u.hash : "/settings/integrations";
    };
    const connectedUrl = (to: string) => {
      const u = new URL(samePage(to), window.location.origin);
      u.searchParams.set("slack", "connected");
      return u.pathname + u.search + u.hash;
    };
    complete({ code: pending.code, state: pending.state })
      .then((res) => {
        clearSlackReturn(pending);
        const to = typeof res?.return_to === "string" ? res.return_to : "/settings/integrations";
        if (res?.ok) {
          returnToApp(connectedUrl(to));
        } else {
          setFailure({ code: String(res?.error ?? "exchange_failed"), returnTo: samePage(to) });
        }
      })
      .catch((error) => {
        captureException(error);
        clearSlackReturn(pending);
        setFailure({ code: "exchange_failed", returnTo: "/settings/integrations" });
      });
  }, [pending, isLoading, isAuthenticated, complete, navigate, returnToApp]);

  return (
    <main className="min-h-screen bg-sol-bg flex items-center justify-center p-8">
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
              onClick={() => returnToApp(isAuthenticated ? failure.returnTo : `/login?return_to=${encodeURIComponent(failure.returnTo)}`)}
              className="mt-5 text-xs px-3 py-1.5 rounded-md border border-sol-border text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"
            >
              {isAuthenticated ? "Go back" : "Sign in to Codecast"}
            </button>
          </>
        ) : (
          <>
            <h1 className="text-sm font-semibold text-sol-text">Connecting Slack</h1>
            <p className="mt-2 text-xs text-sol-text-muted">Finishing the install with your workspace.</p>
          </>
        )}
      </div>
    </main>
  );
}
