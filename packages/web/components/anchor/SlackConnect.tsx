"use client";

// The workspace agent's Slack connection (org-staffing.md S22): one section on
// the root role's Settings tab. Connect the Slack workspace in one click, see
// the channels whose @mentions wake the agent, unlink one. The install
// completes on /slack/connect and comes back to the role's page.

import { useAction, useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { SlackLogo } from "../SlackLogo";
import { useAnchorSpace } from "../../hooks/useSyncAnchorSpace";

export function SlackConnect({ scope, teamId, agentName }: { scope: "team" | "user"; teamId?: string | null; agentName: string }) {
  const { space } = useAnchorSpace(scope, teamId);
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const unlink = useMutation(api.slack.unlinkChannel);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connected = !!space?.slack?.connected;
  const channels: any[] = space?.channels ?? [];

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const returnTo = "/anchor";
      const res = await getInstallUrl({ scope_type: scope, team_id: teamId ?? undefined, return_to: returnTo, origin: window.location.origin } as any);
      if (res?.ok && res.url) {
        window.location.href = res.url;
      } else {
        setErr(res?.error ?? "Couldn't start the Slack connection");
        setBusy(false);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't reach Slack");
      setBusy(false);
    }
  };

  return (
    <div>
      {connected ? (
        <>
          <div className="flex items-center gap-2 text-xs text-sol-green mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green" />
            Connected{space?.slack?.workspace_name ? ` · ${space.slack.workspace_name}` : ""}
          </div>
          {channels.length === 0 ? (
            <p className="text-xs text-sol-text-dim leading-relaxed">
              Invite the bot to a channel in Slack, then run <code>cast anchor link-channel &lt;id&gt;</code>.
              @mentions there wake {agentName}.
            </p>
          ) : (
            <ul className="space-y-1">
              {channels.map((c) => (
                <li key={c.channel_key} className="flex items-center justify-between text-xs">
                  <span className="font-mono text-sol-text-muted truncate">{c.channel_key}</span>
                  <button onClick={() => unlink({ channel: c.channel_key } as any)} className="text-sol-text-dim hover:text-sol-red">
                    unlink
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button onClick={connect} className="mt-3 text-xs text-sol-text-dim hover:text-sol-text">
            Reconnect
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-sol-text-muted mb-3 leading-relaxed">
            Let {agentName} answer @mentions in your Slack. One click, no manual tokens.
          </p>
          <button
            onClick={connect}
            disabled={busy}
            style={{ backgroundColor: "#4A154B" }}
            className="text-white text-sm font-medium rounded-lg px-4 py-2 inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <SlackLogo className="w-4 h-4" />
            {busy ? "Opening Slack…" : "Add to Slack"}
          </button>
        </>
      )}
      {err && <div className="text-sol-red text-xs mt-2">{err}</div>}
    </div>
  );
}
