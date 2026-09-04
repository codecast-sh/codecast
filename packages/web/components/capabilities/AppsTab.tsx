"use client";

import { api } from "@codecast/convex/convex/_generated/api";
import { Loader2 } from "lucide-react";
import {
  APP_DESCRIPTORS,
  APP_IDS,
  type AppConnectionStatus,
  type AppDescriptor,
} from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { type GithubInstallUser } from "../../lib/githubAppInstall";
import { APP_LOOK, useAppConnection } from "../../lib/integrations";
import { InlineSpinner, SurfaceError } from "./EmptyStates";

/**
 * The Apps tab of /capabilities: the services a workspace can connect so agents
 * can act through them. The catalog is `APP_DESCRIPTORS` (shared contracts);
 * connection state is `appConnections.listConnections`; the connect flows are
 * the EXISTING ones — Slack's getInstallUrl action (slack.ts) and the GitHub
 * App install URL (lib/githubAppInstall, shared with the settings page) — this
 * surface only presses their buttons.
 *
 * Deliberately logo-less: a kind icon in an accent tile plus the name in strong
 * type, never a third-party logo asset.
 */

// Per-app rendering identity. Web-only on purpose — the shared descriptor
// stays free of render concerns.

const connectedDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function ScopePill({ scope }: { scope: "team" | "personal" }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-[1px] text-[10px] font-mono border border-sol-border text-sol-text-muted">
      {scope}
    </span>
  );
}

function AppCard({
  descriptor,
  connection,
  loading,
  me,
}: {
  descriptor: AppDescriptor;
  /** Undefined while the query has not answered (or failed) — unknown, not "no". */
  connection: AppConnectionStatus | undefined;
  loading: boolean;
  me: GithubInstallUser | null | undefined;
}) {
  const { icon: Icon, accent } = APP_LOOK[descriptor.id];
  const comingSoon = descriptor.connectKind === "coming-soon";
  const connected = connection?.status === "connected" ? connection : null;

  const { connect, disconnect: revoke, busy, error } = useAppConnection(descriptor, connection, me);
  const disconnect = async () => {
    if (!connected?.disconnect_id) return;
    if (!confirm(`Disconnect ${descriptor.name}? Agents lose access it granted.`)) return;
    await revoke();
  };
  return (
    <div
      className={`rounded-lg border border-sol-border bg-sol-card p-4 flex flex-col gap-2.5 ${
        comingSoon ? "opacity-60" : ""
      }`}
      aria-disabled={comingSoon || undefined}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
        >
          <Icon className="w-4.5 h-4.5" />
        </span>
        <span className="text-sm font-semibold text-sol-text tracking-tight">
          {descriptor.name}
        </span>
        <span className="flex-1" />
        {comingSoon ? (
          <span className="text-[10px] font-mono text-sol-text-dim border border-dashed border-sol-border rounded px-1.5 py-[1px]">
            on the roadmap
          </span>
        ) : loading ? (
          <InlineSpinner label="checking" />
        ) : connected ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-green">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green" />
            Connected
          </span>
        ) : connection ? (
          <span className="text-[11px] text-sol-text-dim">Not connected</span>
        ) : null /* query failed: unknown, claim nothing */}
      </div>

      <p className="text-xs text-sol-text-muted leading-relaxed">{descriptor.tagline}</p>

      <ul className="space-y-1">
        {descriptor.bullets.map((b) => (
          <li key={b} className="flex gap-1.5 text-[11px] text-sol-text-muted leading-snug">
            <span className="text-sol-text-dim select-none">·</span>
            {b}
          </li>
        ))}
      </ul>

      <div className="flex-1" />

      {error && <p className="text-[11px] text-sol-red break-words">{error}</p>}

      {connected ? (
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-muted">
          <ScopePill scope={connected.scope} />
          <span className="truncate">
            by {connected.by_me ? "you" : (connected.by ?? "a removed account")}
            {" · "}
            {connectedDate(connected.at)}
            {connected.detail ? ` · ${connected.detail}` : ""}
          </span>
          <span className="flex-1" />
          {/* Only where a real revoke path exists (GitHub). Slack has none
              server-side, so no button rather than a dead one. */}
          {connected.disconnect_id && (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="text-[11px] text-sol-red hover:underline disabled:opacity-50"
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </button>
          )}
        </div>
      ) : comingSoon ? (
        <p className="text-[11px] text-sol-text-dim">
          No connector yet — this card turns live when it lands.
        </p>
      ) : (
        <div>
          {/* When the state query failed, this app may already be connected —
              offering Connect would overclaim. Disabled, with the reason. */}
          <button
            type="button"
            onClick={connect}
            disabled={busy || (!connection && !loading)}
            title={
              !connection && !loading
                ? "Connection state didn't load — retry once it does"
                : undefined
            }
            className="inline-flex items-center gap-1.5 h-7 px-3 text-xs rounded border border-sol-border text-sol-text hover:bg-sol-bg-highlight disabled:opacity-50 transition-colors"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Connect
          </button>
        </div>
      )}
    </div>
  );
}

export function AppsTab() {
  const connections = useQueryNoThrow(api.appConnections.listConnections, {});
  const me = useQueryNoThrow(api.users.getCurrentUser, {});
  const loading = connections.data === undefined && !connections.error;
  const byId = new Map<string, AppConnectionStatus>(
    (connections.data?.apps ?? []).map((a: AppConnectionStatus) => [a.id, a]),
  );

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-sol-text-dim max-w-2xl leading-relaxed">
        Connections belong to your workspace, not to a machine. Tokens stay server-side — an
        agent asks the backend to act, it never holds the credential.
      </p>
      {connections.error && (
        <SurfaceError
          title="Couldn't load connection state"
          detail={connections.error.message}
        />
      )}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
        {APP_IDS.map((id) => (
          <AppCard
            key={id}
            descriptor={APP_DESCRIPTORS[id]}
            connection={byId.get(id)}
            loading={loading}
            me={me.data}
          />
        ))}
      </div>
    </div>
  );
}
