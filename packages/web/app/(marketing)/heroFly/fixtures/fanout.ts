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

/**
 * When each worker's prompt, its first look around and its next tool call
 * land on its own surface: the prompt and the first look are in place as the
 * camera sets off for the pair (16.7), the next call lands while it holds.
 */
export const BOOT = {
  api: { prompt: 16.6, seed: 16.75, tool: 18.8 },
  ui: { prompt: 16.7, seed: 16.85, tool: 19.15 },
} as const;

/** The status a worker's header shows as the film moves. */
export const workerStatus = (which: "api" | "ui", t: number) => {
  const boot = BOOT[which];
  if (t < boot.prompt) return "starting";
  if (which === "api" && t >= CUES.permissionAsk && t < CUES.permissionApproved) return "permission_blocked";
  return "working";
};

type Boot = { task: string; model: string; seed: ToolCall; seedResult: ToolResult; tool: ToolCall; result: ToolResult };

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input: JSON.stringify(input) });

export const WORKERS: Record<"api" | "ui", Boot> = {
  api: {
    task: API_TASK,
    model: "gpt-5.5-codex",
    seed: call("hero-tool-api-open", "Read", { file_path: "/u/src/billing/src/api/hooks.ts" }),
    seedResult: { tool_use_id: "hero-tool-api-open", content: "export async function handleHook(hook: Webhook) {\n  await deliver(hook);\n}" },
    tool: call("hero-tool-api-read", "Bash", { command: "rg -n \"deliver\\(\" src/api" }),
    result: { tool_use_id: "hero-tool-api-read", content: "src/api/hooks.ts:88:    await deliver(hook);\nsrc/api/hooks.ts:131:  return deliver(hook, attempt);" },
  },
  ui: {
    task: UI_TASK,
    model: "composer-2",
    seed: call("hero-tool-ui-grep", "Grep", { pattern: "FailedList", path: "web/src" }),
    seedResult: { tool_use_id: "hero-tool-ui-grep", content: "web/src/webhooks/FailedList.tsx\nweb/src/webhooks/index.ts" },
    tool: call("hero-tool-ui-read", "Read", { file_path: "/u/src/billing/web/src/webhooks/FailedList.tsx" }),
    result: { tool_use_id: "hero-tool-ui-read", content: "export function FailedList({ hooks }: { hooks: Webhook[] }) {\n  return <Table rows={hooks} columns={COLUMNS} />;\n}" },
  },
};

export const WORKER_SESSIONS = { api: SESSIONS.api, ui: SESSIONS.ui };

export const entities: Record<string, EntityFixture> = {};
