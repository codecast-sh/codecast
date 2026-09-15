"use client";

// The header's one word about Slack. Mirrored: the mark and a state dot, and
// nothing else, because the channel's name IS the Slack channel's name and the
// header already shows it; click for the settings, hover for the workspace and
// the direction. Not mirrored: a quiet "Slack" affordance that opens the
// setup. Paused or erroring: the dot says so before anyone wonders why a line
// did not cross.
import { useState } from "react";
import { AlertTriangle, Pause } from "lucide-react";
import { DIRECTION_LABEL, MIRROR_STATE_LABEL, mirrorState as linkState, type SlackMirrorState } from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../SlackLogo";
import { SlackSyncDialog } from "./SlackSyncDialog";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import "./chat.css";

type MirrorState = "none" | SlackMirrorState;

function mirrorState(link: ChatSlackLinkRow | null): MirrorState {
  return link ? linkState(link) : "none";
}

function titleFor(link: ChatSlackLinkRow | null): string {
  if (!link) return "Mirror this channel with Slack";
  const there = `#${link.slack_channel_name ?? link.slack_channel_id}`;
  const state = linkState(link);
  const where = link.slack_team_name ? ` in ${link.slack_team_name}` : "";
  if (state === "live") return `${MIRROR_STATE_LABEL.live} ${there}${where} (${DIRECTION_LABEL[link.direction]})`;
  return `${MIRROR_STATE_LABEL[state]} · ${there}${where}`;
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
          <StateGlyph state={state} />
        ) : (
          <span className="ch-head-slack-name ch-head-slack-quiet">Slack</span>
        )}
      </button>
      {open && <SlackSyncDialog channelId={channelId} onClose={() => setOpen(false)} />}
    </>
  );
}
