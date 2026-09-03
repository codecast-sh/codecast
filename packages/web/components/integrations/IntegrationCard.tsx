// One provider in the integrations ledger: what it is, whether it is connected,
// who connected it, how healthy it is, what it enables, and the two buttons
// that change any of that.
//
// The card is FLAT — the settings kit gives the surrounding section card the
// only border, so identity here comes from a left accent bar in the provider's
// colour and a monospace ledger line, never from a nested box. Both themes are
// tokens only.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AppConnectionStatus, AppDescriptor } from "@codecast/shared/contracts";
import { APP_LOOK, ISSUE_SYNC_APPS, useAppConnection } from "../../lib/integrations";
import type { GithubInstallUser } from "../../lib/githubAppInstall";
import { githubAppInstallTeam } from "../../lib/githubAppInstall";
import { formatRelative } from "../../lib/utils";
import { ConfirmButton, LedgerLine, QuietButton, StatusDot, type DotTone } from "./parts";
import { GithubInstallDetail } from "./GithubInstallDetail";
import { IssueSyncSources } from "./IssueSyncSources";

/**
 * Health as the connector stamps it (issue-sync.md S1.5). Absent health is
 * silence, not success — the card then says nothing rather than inventing a
 * verdict it cannot support.
 */
function healthLine(connection: Extract<AppConnectionStatus, { status: "connected" }>):
  | { tone: DotTone; text: string }
  | null {
  const h = connection.health;
  if (!h) return null;
  if (h.last_error) return { tone: "bad", text: h.last_error };
  const last = Math.max(h.last_webhook_at ?? 0, h.last_sync_at ?? 0);
  if (!last) return { tone: "warn", text: "no traffic yet" };
  const kind = (h.last_webhook_at ?? 0) >= (h.last_sync_at ?? 0) ? "webhook" : "sync";
  return { tone: "ok", text: `last ${kind} ${formatRelative(last)}` };
}

export function IntegrationCard({
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
  const { connect, disconnect, busy, error } = useAppConnection(descriptor, connection, me);
  const [showDetail, setShowDetail] = useState(false);

  const connected = connection?.status === "connected" ? connection : null;
  const comingSoon = descriptor.connectKind === "coming-soon" || connection?.status === "coming_soon";
  // A connect action that answers `{ok:false,error}` is usually the server
  // saying an env var pair is missing. That is "not configured on this server",
  // not "you did something wrong", and the message names the variables — so it
  // is shown verbatim rather than flattened into a friendlier lie.
  const notConfigured = !!error && /not configured/i.test(error);
  const health = connected ? healthLine(connected) : null;
  const hasSources = ISSUE_SYNC_APPS.includes(descriptor.id);

  return (
    <div
      className="border-l-2 px-4 py-3.5 sm:px-5"
      style={{ borderColor: connected ? accent : `color-mix(in srgb, ${accent} 35%, transparent)` }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)`, color: accent }}
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate text-sm font-semibold tracking-tight text-sol-text">{descriptor.name}</span>
        <span className="flex-1" />
        {comingSoon ? (
          <span className="rounded border border-dashed border-sol-border px-1.5 py-[1px] font-mono text-[10px] text-sol-text-dim">
            on the roadmap
          </span>
        ) : notConfigured ? (
          <StatusDot tone="warn">Not configured</StatusDot>
        ) : connected ? (
          <StatusDot tone="ok">Connected</StatusDot>
        ) : connection ? (
          <StatusDot tone="idle">Not connected</StatusDot>
        ) : loading ? (
          <StatusDot tone="idle">Checking</StatusDot>
        ) : null /* the state query failed: claim nothing */}
      </div>

      {/* The ledger: every fact about this connection in one monospace row. */}
      {connected && (
        <LedgerLine
          className="mt-1.5"
          parts={[
            "connected",
            connected.scope,
            `by ${connected.by_me ? "you" : (connected.by ?? "a removed account")}`,
            formatRelative(connected.at),
            connected.detail,
          ]}
        />
      )}

      <p className="mt-1.5 text-xs leading-relaxed text-sol-text-muted">{descriptor.tagline}</p>

      <ul className="mt-1.5 space-y-0.5">
        {descriptor.bullets.map((b) => (
          <li key={b} className="flex gap-1.5 text-[11px] leading-snug text-sol-text-muted">
            <span className="select-none text-sol-text-dim">·</span>
            {b}
          </li>
        ))}
      </ul>

      {health && <div className="mt-1.5">
        <StatusDot tone={health.tone}>{health.text}</StatusDot>
      </div>}

      {error && <p className="mt-1.5 break-words text-[11px] leading-relaxed text-sol-red">{error}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-3">
        {comingSoon ? (
          <span className="text-[11px] text-sol-text-dim">
            No connector yet — this card turns live when it lands.
          </span>
        ) : connected ? (
          <>
            {/* Only where a real revoke path exists for THIS caller. Slack has
                none server-side, and a plain member cannot revoke the GitHub
                App — no button beats a button that can only fail. */}
            {connected.disconnect_id && (
              <ConfirmButton
                label="Disconnect"
                question={`Agents lose the access ${descriptor.name} granted.`}
                onConfirm={disconnect}
                busy={busy}
                busyLabel="Disconnecting"
              />
            )}
            {descriptor.id === "github" && (
              <button
                type="button"
                onClick={() => setShowDetail((v) => !v)}
                aria-expanded={showDetail}
                className="inline-flex items-center gap-1 text-[11px] text-sol-text-muted hover:text-sol-text"
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showDetail ? "" : "-rotate-90"}`} />
                Installed accounts and repositories
              </button>
            )}
          </>
        ) : (
          <QuietButton
            onClick={connect}
            busy={busy}
            // When the state query failed this app may already be connected;
            // offering Connect would overclaim.
            disabled={!connection && !loading}
            title={!connection && !loading ? "Connection state didn't load — retry once it does" : undefined}
          >
            Connect
          </QuietButton>
        )}
      </div>

      {descriptor.id === "github" && showDetail && (
        <GithubInstallDetail teamId={me ? githubAppInstallTeam(me) : undefined} />
      )}

      {hasSources && (
        <IssueSyncSources provider={descriptor.id as "github" | "linear"} connected={!!connected} />
      )}
    </div>
  );
}
