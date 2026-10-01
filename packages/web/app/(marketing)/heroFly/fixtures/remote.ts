/**
 * Chapter 13, Anywhere: the machines the film's sessions run on, and the API
 * worker on the cloud host: its tmux pane, and the browser it drives there.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { SessionMachine } from "@/lib/sessionMachines";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { CLOUD_HOST } from "./desk";
import { OBJECTS } from "./story";

/** The inset drops in just ahead of the camera (83.4), its rows 80ms apart. */
export const INSET = { cue: 82.9, step: 0.08 } as const;

export const MACHINES: SessionMachine[] = [
  { device_id: "hero-dev-mac", label: `${OBJECTS.hosts.laptop}.local`, hostname: OBJECTS.hosts.laptop, platform: "darwin", last_seen: 0, is_remote: false, local_project_roots: [], online: true },
  CLOUD_HOST,
];

/** The API worker's tmux pane on the cloud host. */
export const TMUX_PANE = "cx-webhook-api";

export const ADDRESS = "https://staging.acme.dev/webhooks/failed";

/** The API worker, on the cloud host, opens the failed-webhooks page to watch a retry land. */
export const BROWSE: { tool: ToolCall; result: ToolResult } = {
  tool: {
    id: "hero-tool-browse",
    name: "Bash",
    input: JSON.stringify({ command: `cast browser open ${ADDRESS}` }),
  },
  result: { tool_use_id: "hero-tool-browse", content: `${ADDRESS}\n  tab 4A2C9E01 (Chrome on ${OBJECTS.hosts.cloud})` },
};

export const entities: Record<string, EntityFixture> = {};
