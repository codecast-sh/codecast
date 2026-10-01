import { useRef, useState } from "react";
import { useAction } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { openExternalUrl } from "../lib/desktop";

/** "self": the person's own token. "team": the workspace install itself (an
 *  admin's gesture), e.g. to grant the app newer scopes. */
export function useSlackConnect(teamId: string | undefined, returnTo: string, scopeType: "self" | "team" = "self") {
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const key = `${scopeType}:${teamId}:${returnTo}`;
  const pending = useRef(false);
  const [attempt, setAttempt] = useState<{ key: string; busy: boolean; started: boolean; error: string | null } | null>(null);
  const current = attempt?.key === key ? attempt : null;

  const connect = async () => {
    if (!teamId || pending.current) return;
    pending.current = true;
    setAttempt({ key, busy: true, started: false, error: null });
    try {
      const res = await getInstallUrl({
        scope_type: scopeType,
        team_id: teamId as Id<"teams">,
        return_to: returnTo,
        origin: window.location.origin,
      });
      if (!res?.ok || !res.url) {
        setAttempt({ key, busy: false, started: false, error: "Couldn’t open Slack. Try connecting again." });
        return;
      }
      openExternalUrl(res.url);
      setAttempt({ key, busy: false, started: true, error: null });
    } catch (error) {
      captureException(error);
      setAttempt({ key, busy: false, started: false, error: "Couldn’t open Slack. Try connecting again." });
    } finally {
      pending.current = false;
    }
  };

  return { connect, busy: current?.busy ?? false, started: current?.started ?? false, error: current?.error ?? null };
}
