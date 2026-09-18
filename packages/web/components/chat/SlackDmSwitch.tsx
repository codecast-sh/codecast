"use client";

// One person's direct messages, on or off. Lives under the team's Slack card
// and in the channel browser. Three states, in the order a person meets them:
// no Slack account connected (one button), connected without the DM scopes
// (one button that asks Slack for them), connected and ready (the switch, the
// history window, and what the scan found). Everything it shows comes from
// getTeamSlack, so the settings card and the browser cannot disagree.
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { AlertTriangle, Loader2, MessageSquareLock } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { BACKFILL_WINDOWS, type BackfillWindow } from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../SlackLogo";
import { openExternalUrl } from "../../lib/desktop";
import { Switch } from "../ui/switch";
import "./chat.css";

export function SlackDmSwitch({ teamId, compact }: { teamId: string; compact?: boolean }) {
  const team = useQuery(api.slackSync.getTeamSlack, { team_id: teamId } as any);
  const setDmSync = useMutation(api.slackSync.setDmSync);
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [window_, setWindow] = useState<BackfillWindow | null>(null);

  if (!team?.installation) return null;
  const sync = team.dm_sync as { enabled: boolean; window: string; status?: string; conversations?: number; error?: string } | null;
  const enabled = !!sync?.enabled;
  const window = (window_ ?? (sync?.window as BackfillWindow | undefined) ?? "30d") as BackfillWindow;

  // The same consent screen as connecting; Slack adds the DM scopes to the
  // token and the person lands back here.
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res: any = await getInstallUrl({
        scope_type: "self",
        team_id: teamId,
        return_to: "/settings/integrations?slack=connected",
        origin: location.origin,
      } as any);
      if (res?.ok && res.url) openExternalUrl(res.url);
      else setErr(res?.error ?? "Couldn't start the Slack connection");
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't start the Slack connection");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await setDmSync({ team_id: teamId, enabled: on, window } as any);
    } catch (e: any) {
      const msg = e?.data?.message ?? e?.message ?? "Couldn't change that";
      setErr(msg === "reconnect" ? "Slack needs to grant access to your direct messages first." : msg);
    } finally {
      setBusy(false);
    }
  };

  const needsConnect = !team.you_connected;
  const needsScopes = team.you_connected && !team.dm_ready;

  return (
    <div className={`ch-slack-dms ${compact ? "ch-slack-dms-compact" : ""}`}>
      <div className="ch-slack-dms-row">
        <MessageSquareLock className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
        <div className="min-w-0 flex-1">
          <div className="ch-slack-dms-title">Your direct messages</div>
          <div className="ch-slack-fine">
            {needsConnect && "Connect your Slack account to bring your DMs here."}
            {needsScopes && "Slack has to grant access to your direct messages once."}
            {!needsConnect && !needsScopes && !enabled && "Each of your Slack DMs becomes a DM here: teammates as themselves, everyone else under their Slack name. Your replies here go to Slack as you."}
            {enabled && sync?.status === "scanning" && (
              <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Finding your conversations · {sync.conversations ?? 0} so far</span>
            )}
            {enabled && sync?.status === "done" && `${sync.conversations ?? 0} conversation${(sync.conversations ?? 0) === 1 ? "" : "s"} mirrored · new ones follow as they happen`}
            {enabled && sync?.status === "failed" && <span className="text-sol-orange">The scan stopped: {sync.error ?? "unknown"}. Switch off and on to run it again.</span>}
          </div>
        </div>
        {needsConnect || needsScopes ? (
          <button type="button" className="ch-slack-secondary" onClick={connect} disabled={busy}>
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <SlackLogo className="w-3 h-3" />}
            {needsConnect ? "Connect your Slack account" : "Allow direct messages"}
          </button>
        ) : (
          <Switch checked={enabled} disabled={busy} onCheckedChange={toggle} aria-label="Bring my direct messages" />
        )}
      </div>
      {!needsConnect && !needsScopes && !enabled && (
        <div className="ch-slack-dms-window">
          <span className="ch-slack-fine">History:</span>
          <div className="ch-slack-seg" role="radiogroup" aria-label="History to bring in">
            {BACKFILL_WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="radio"
                aria-checked={window === w.key}
                className={`ch-slack-seg-item ${window === w.key ? "ch-slack-seg-on" : ""}`}
                onClick={() => setWindow(w.key)}
                disabled={busy}
                title={w.hint}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {err && <div className="ch-slack-err"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{err}</div>}
    </div>
  );
}
