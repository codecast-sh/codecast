/**
 * Chapter 13, Anywhere: the API worker, which the lead spawned on the cloud
 * host, opened from its row in the inbox: its conversation's tail, where it
 * drives a browser on that host to watch a retry land on staging.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { OBJECTS } from "./story";

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

/** What the worker says around the call: why it looks, and what it saw. */
export const BEFORE = "The retry endpoint is merged. I'll watch a replayed event land on staging.";
export const AFTER = "The replayed event moved from failed to delivered on its second attempt. The retry endpoint is green on staging.";

export const entities: Record<string, EntityFixture> = {};
