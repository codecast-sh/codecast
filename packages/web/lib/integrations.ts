// The one implementation of "connect / disconnect this app", shared by the
// /settings/integrations page and the older /capabilities Apps tab.
//
// The catalog is `APP_DESCRIPTORS` (shared contracts) and connection state is
// `appConnections.listConnections`; neither is duplicated here. What lives here
// is the wiring both surfaces need and used to each own a copy of: which
// existing connect flow a provider runs, which disconnect action takes its id,
// and the render identity (icon + accent) a web surface draws it with.
//
// Deliberately logo-less: a kind icon in an accent tile plus the name in strong
// type, never a third-party logo asset.

import { useState, type ComponentType, type CSSProperties } from "react";
import { useAction, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { GitPullRequest, ListChecks, Mail, MessagesSquare, NotebookText } from "lucide-react";
import type { AppConnectionStatus, AppDescriptor, AppId } from "@codecast/shared/contracts";
import { githubAppInstallUrl, type GithubInstallUser } from "./githubAppInstall";
import { formatRelative } from "./utils";
import type { IssueProvider, TaskExternal } from "../store/inboxStore";

const api = _api as any;

/** Icons are drawn in their app's accent, so the type has to allow a style.
 *  Every value here is a lucide icon, which takes both. */
type AppIcon = ComponentType<{ className?: string; style?: CSSProperties }>;

/** Per-app render identity. Web-only on purpose — the shared descriptor stays
 *  free of render concerns. */
export const APP_LOOK: Record<AppId, { icon: AppIcon; accent: string }> = {
  slack: { icon: MessagesSquare, accent: "var(--sol-magenta)" },
  github: { icon: GitPullRequest, accent: "var(--sol-violet)" },
  gmail: { icon: Mail, accent: "var(--sol-red)" },
  linear: { icon: ListChecks, accent: "var(--sol-blue)" },
  notion: { icon: NotebookText, accent: "var(--sol-yellow)" },
};

/** Apps whose sources the issue sync UI hangs off (docs/architecture/issue-sync.md S9). */
export const ISSUE_SYNC_APPS: readonly AppId[] = ["github", "linear"];

/** How a provider is named in prose. */
export const ISSUE_PROVIDER_NAME: Record<IssueProvider, string> = {
  linear: "Linear",
  github: "GitHub",
};

/** The hover title every surface puts on a task's provider identity: which
 *  provider, how fresh, and the sync error when there is one. */
export function issueSyncTitle(external: TaskExternal): string {
  const base = `${ISSUE_PROVIDER_NAME[external.provider]} issue, synced ${formatRelative(external.synced_at)}`;
  return external.last_error ? `${base}. Sync error: ${external.last_error}` : base;
}

export type AppConnectionActions = {
  connect: () => Promise<void>;
  /** Runs the revoke. Confirmation belongs to the caller's UI, not here. */
  disconnect: () => Promise<void>;
  busy: boolean;
  /**
   * The last refusal, in the words the server used. A connect action that
   * answers `{ok:false,error}` is usually the server saying an env var pair is
   * missing — shown as-is, because "not configured" without naming the
   * variable sends the reader looking in the wrong place.
   */
  error: string | null;
  setError: (message: string | null) => void;
};

/**
 * The connect and disconnect gestures for one app. Every branch calls a flow
 * that already exists server-side: Slack's getInstallUrl, googleOAuth's
 * getConnectUrl/disconnect, the generic oauthConnectors pair for Linear and
 * Notion, the GitHub App install URL and githubApp.deleteInstallation.
 */
export function useAppConnection(
  descriptor: AppDescriptor,
  connection: AppConnectionStatus | undefined,
  me: GithubInstallUser | null | undefined,
): AppConnectionActions {
  const getSlackUrl = useAction(api.slack.getInstallUrl);
  const getGoogleUrl = useAction(api.googleOAuth.getConnectUrl);
  const disconnectGoogle = useAction(api.googleOAuth.disconnect);
  const getConnectorUrl = useAction(api.oauthConnectors.getConnectUrl);
  const disconnectConnector = useAction(api.oauthConnectors.disconnect);
  const deleteGithubInstallation = useMutation(api.githubApp.deleteInstallation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connection?.status === "connected" ? connection : null;

  /** Run `fn`, holding the busy flag and reporting whatever it refuses with. */
  const attempt = async (fn: () => Promise<void>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message ?? fallback);
    } finally {
      setBusy(false);
    }
  };

  /** Open an authorize URL the server minted, or report why it minted none. */
  const openMinted = async (
    mint: () => Promise<{ ok?: boolean; url?: string; error?: string } | null>,
    fallback: string,
  ) => {
    const res = await mint();
    if (res?.ok && res.url) window.open(res.url, "_blank", "noopener");
    else setError(res?.error ?? fallback);
  };

  const connect = async () => {
    if (descriptor.connectKind === "github-app-install") {
      // The shared helper resolves the SAME workspace the connected-state query
      // reads (active_team_id ?? team_id) — minting from a different team would
      // install into one workspace while the card reports another.
      setError(null);
      const url = me ? githubAppInstallUrl(me) : null;
      if (!url) {
        setError("Join or create a team first — the GitHub App binds to a team");
        return;
      }
      window.open(url, "_blank", "noopener");
      return;
    }
    if (descriptor.connectKind !== "oauth-popup") return;

    await attempt(async () => {
      if (descriptor.id === "gmail") {
        // Readonly scope only on first connect; the send grant is a later ask.
        await openMinted(() => getGoogleUrl({}), "Couldn't start the Google connection");
      } else if (descriptor.id === "linear" || descriptor.id === "notion") {
        // The generic connector: one flow, provider in the signed state.
        await openMinted(
          () => getConnectorUrl({ provider: descriptor.id }),
          `Couldn't start the ${descriptor.name} connection`,
        );
      } else {
        // Slack's "Add to Slack": the popup lands back on /anchor authenticated.
        await openMinted(() => getSlackUrl({ scope_type: "team" }), "Couldn't start the Slack connection");
      }
    }, `Couldn't reach ${descriptor.name}`);
  };

  const disconnect = async () => {
    const installationId = connected?.disconnect_id;
    if (!installationId) return;
    await attempt(async () => {
      if (descriptor.id === "linear" || descriptor.id === "notion") {
        await disconnectConnector({ installation_id: installationId });
      } else if (descriptor.id === "gmail") {
        await disconnectGoogle({ installation_id: installationId });
      } else {
        await deleteGithubInstallation({ installation_id: installationId as any });
      }
    }, `Couldn't disconnect ${descriptor.name}`);
  };

  return { connect, disconnect, busy, error, setError };
}
