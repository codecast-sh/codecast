/**
 * Chapter 3, Fan out: the two workers booting on the pair, each with the task
 * the lead handed it and its first tool call. The spawn blocks themselves sit
 * in the lead's transcript (fixtures/conversation.ts) and the worker rows in
 * the inbox (fixtures/desk.ts).
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { API_TASK, UI_TASK } from "./conversation";
import { CUES, SESSIONS } from "./story";

/** When each worker's prompt and first tool call land on its own surface. */
export const BOOT = {
  api: { prompt: 18.8, tool: 19.6 },
  ui: { prompt: 19.1, tool: 19.95 },
} as const;

/** The status a worker's header shows as the film moves. */
export const workerStatus = (which: "api" | "ui", t: number) => {
  const boot = BOOT[which];
  if (t < boot.prompt) return "starting";
  if (which === "api" && t >= CUES.permissionAsk && t < CUES.permissionApproved) return "permission_blocked";
  return "working";
};

type Boot = { task: string; model: string; tool: ToolCall; result: ToolResult };

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input: JSON.stringify(input) });

export const WORKERS: Record<"api" | "ui", Boot> = {
  api: {
    task: API_TASK,
    model: "gpt-5.5-codex",
    tool: call("hero-tool-api-read", "Bash", { command: "rg -n \"deliver\\(\" src/api" }),
    result: { tool_use_id: "hero-tool-api-read", content: "src/api/hooks.ts:88:    await deliver(hook);\nsrc/api/hooks.ts:131:  return deliver(hook, attempt);" },
  },
  ui: {
    task: UI_TASK,
    model: "composer-2",
    tool: call("hero-tool-ui-read", "Read", { file_path: "/u/src/billing/web/src/webhooks/FailedList.tsx" }),
    result: { tool_use_id: "hero-tool-ui-read", content: "export function FailedList({ hooks }: { hooks: Webhook[] }) {\n  return <Table rows={hooks} columns={COLUMNS} />;\n}" },
  },
};

export const WORKER_SESSIONS = { api: SESSIONS.api, ui: SESSIONS.ui };

export const entities: Record<string, EntityFixture> = {};
