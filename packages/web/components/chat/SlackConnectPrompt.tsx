import { ArrowUpRight, Loader2 } from "lucide-react";
import { SlackLogo } from "../SlackLogo";
import type { SlackDelivery } from "../../lib/slackDelivery";
import "./chat.css";

export function SlackConnectPrompt({ auth, busy, started, error, onConnect }: {
  auth: SlackDelivery["auth"];
  busy: boolean;
  started: boolean;
  error: string | null;
  onConnect: () => void;
}) {
  if (auth === "ready") return null;
  if (auth === "checking") return (
    <div className="ch-slack-connect ch-slack-connect-checking" role="status">
      <SlackLogo className="w-3.5 h-3.5" muted />
      <span>Checking your Slack connection…</span>
    </div>
  );
  const reconnect = auth === "reconnect";
  return (
    <div className="ch-slack-connect">
      <SlackLogo className="ch-slack-connect-icon" />
      <div className="ch-slack-connect-copy" aria-live="polite">
        <span className="ch-slack-connect-title">{reconnect ? "Allow replies in Slack" : "Reply in Slack, too"}</span>
        <p>{started
          ? "Finish connecting in Slack. Your draft stays here."
          : reconnect
            ? "Slack needs permission to send as you. For now, your messages stay in Codecast."
            : "Your messages stay in Codecast until you connect your Slack account."}</p>
        {error && <p className="ch-slack-connect-error" role="alert">{error}</p>}
      </div>
      <button type="button" className="ch-slack-connect-button" onClick={onConnect} disabled={busy}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : null}
        {busy ? "Opening Slack…" : started ? "Open Slack again" : reconnect ? "Allow replies" : "Connect Slack"}
        {!busy && <ArrowUpRight className="w-3 h-3" aria-hidden="true" />}
      </button>
    </div>
  );
}
