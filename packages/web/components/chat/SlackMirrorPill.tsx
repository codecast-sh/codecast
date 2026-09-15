"use client";

// The header's one word about Slack. Mirrored: the mark, the Slack channel's
// name and a live dot; click for the settings. Not mirrored: a quiet "Slack"
// affordance that opens the setup. Paused or erroring: the dot says so before
// anyone wonders why a line did not cross.
import { useState } from "react";
import { AlertTriangle, Pause } from "lucide-react";
import { DIRECTION_LABEL } from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../SlackLogo";
import { SlackSyncDialog } from "./SlackSyncDialog";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import "./chat.css";

type MirrorState = "none" | "paused" | "error" | "live";

function mirrorState(link: ChatSlackLinkRow | null): MirrorState {
  if (!link) return "none";
  if (link.paused) return "paused";
  if (link.last_error) return "error";
  return "live";
}

function titleFor(link: ChatSlackLinkRow | null): string {
  if (!link) return "Mirror this channel with Slack";
  const there = `#${link.slack_channel_name ?? link.slack_channel_id}`;
  if (link.paused) return `Slack mirror paused · ${there}`;
  if (link.last_error) return `Slack mirror needs attention · ${there}`;
  return `Mirrored with Slack ${there} (${DIRECTION_LABEL[link.direction]})`;
}

function StateGlyph({ state }: { state: MirrorState }) {
  switch (state) {
    case "paused":
      return <Pause className="ch-head-slack-glyph" aria-hidden="true" />;
    case "error":
      return <AlertTriangle className="ch-head-slack-glyph ch-head-slack-glyph-warn" aria-hidden="true" />;
    default:
      return <span className="ch-head-slack-dot" aria-hidden="true" />;
  }
}

export function SlackMirrorPill({ channelId, link }: { channelId: string; link: ChatSlackLinkRow | null }) {
  const [open, setOpen] = useState(false);
  const state = mirrorState(link);
  const title = titleFor(link);
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
            <StateGlyph state={state} />
          </>
        ) : (
          <span className="ch-head-slack-name ch-head-slack-quiet">Slack</span>
        )}
      </button>
      {open && <SlackSyncDialog channelId={channelId} onClose={() => setOpen(false)} />}
    </>
  );
}
