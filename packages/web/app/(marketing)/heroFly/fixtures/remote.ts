/**
 * Chapter 13, Anywhere: the machines the film's sessions run on, the cloud
 * host session's tmux pane, and a `cast computer` call on the cloud host.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { SessionMachine } from "@/lib/sessionMachines";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { CLOUD_HOST } from "./desk";
import { OBJECTS } from "./story";

/** The inset drops in just ahead of the camera, its rows 80ms apart. */
export const INSET = { cue: 79.9, step: 0.08 } as const;

export const MACHINES: SessionMachine[] = [
  { device_id: "hero-dev-mac", label: `${OBJECTS.hosts.laptop}.local`, hostname: OBJECTS.hosts.laptop, platform: "darwin", last_seen: 0, is_remote: false, local_project_roots: [], online: true },
  CLOUD_HOST,
];

export const TMUX_PANE = "cc-rate-limit";

export const ADDRESS = "https://staging.acme.dev/webhooks/failed";

export const COMPUTER: { tool: ToolCall; result: ToolResult } = {
  tool: {
    id: "hero-tool-computer",
    name: "Bash",
    input: JSON.stringify({ command: `cast computer set-value --app com.apple.Safari --element-index 12 --value "${ADDRESS}"` }),
  },
  result: { tool_use_id: "hero-tool-computer", content: "Set value completed via accessibility, verified (value). 58 visible elements in current window." },
};

export const entities: Record<string, EntityFixture> = {};
