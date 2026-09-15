"use client";

// The header's one word about Slack. Mirrored: the mark, the Slack channel's
// name and a live dot; click for the settings. Not mirrored: a quiet "Slack"
// affordance that opens the setup. Paused or erroring: the dot says so before
// anyone wonders why a line did not cross.
import { useState } from "react";
import { AlertTriangle, Pause } from "lucide-react";
import { SlackLogo } from "../SlackLogo";
import { SlackSyncDialog } from "./SlackSyncDialog";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import "./chat.css";

export function SlackMirrorPill({ channelId, link }: { channelId: string; link: ChatSlackLinkRow | null }) {
  const [open, setOpen] = useState(false);
  const state = !link ? "none" : link.paused ? "paused" : link.last_error ? "error" : "live";
  const title = !link
    ? "Mirror this channel with Slack"
    : link.paused
      ? `Slack mirror paused · #${link.slack_channel_name ?? link.slack_channel_id}`
      : link.last_error
        ? `Slack mirror needs attention · #${link.slack_channel_name ?? link.slack_channel_id}`
        : `Mirrored with Slack #${link.slack_channel_name ?? link.slack_channel_id} (${
          link.direction === "both" ? "both ways" : link.direction === "slack_to_codecast" ? "from Slack" : "to Slack"
        })`;
  return (
    <>
      <button
        type="button"
        className={`ch-head-slack ch-head-slack-${state}`}
        title={title}
        aria-label={title}
        onClick={() => setOpen(true)}
      >
        <SlackLogo className="w-3 h-3" muted={state !== "live"} />
        {link ? (
          <>
            <span className="ch-head-slack-name">{link.slack_channel_name ?? link.slack_channel_id}</span>
            {state === "paused" ? (
              <Pause className="ch-head-slack-glyph" aria-hidden="true" />
            ) : state === "error" ? (
              <AlertTriangle className="ch-head-slack-glyph ch-head-slack-glyph-warn" aria-hidden="true" />
            ) : (
              <span className="ch-head-slack-dot" aria-hidden="true" />
            )}
          </>
        ) : (
          <span className="ch-head-slack-name ch-head-slack-quiet">Slack</span>
        )}
      </button>
      {open && <SlackSyncDialog channelId={channelId} onClose={() => setOpen(false)} />}
    </>
  );
}
