/**
 * Chapter 3, Fan out: the two workers booting on the pair, each with the task
 * the lead handed it and its first tool call. The spawn blocks themselves sit
 * in the lead's transcript (fixtures/conversation.ts) and the worker rows in
 * the inbox (fixtures/desk.ts).
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { API_TASK, UI_TASK } from "./conversation";
import { readyAt } from "../world";
import { CUES, SESSIONS } from "./story";

/**
 * When each worker's prompt, its first look around and its next tool call
 * land on its own surface: the prompt and the first look are in place before
 * the pair turns face-up, the next call lands while the camera holds.
 */
export const BOOT = {
  api: { prompt: readyAt("pairA"), seed: readyAt("pairA") + 0.1, tool: 18.8 },
  ui: { prompt: readyAt("pairB") + 0.05, seed: readyAt("pairB") + 0.15, tool: 19.15 },
} as const;

/** The status a worker's header shows as the film moves. */
export const workerStatus = (which: "api" | "ui", t: number) => {
  const boot = BOOT[which];
  if (t < boot.prompt) return "starting";
  // Its turn ended on a question: idle, as the app shows an agent waiting on a reply, until the answer starts the next turn.
  if (which === "api" && t >= CUES.question && t < CUES.answered) return "idle";
  return "working";
};

type Boot = { task: string; model: string; look: string; looks: ToolCall[]; lookResults: ToolResult[]; plan: string; seed: ToolCall; seedResult: ToolResult; tool: ToolCall; result: ToolResult };

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input: JSON.stringify(input) });

export const WORKERS: Record<"api" | "ui", Boot> = {
  api: {
    task: API_TASK,
    model: "gpt-5.5-codex",
    look: "Reading the webhook handlers and the delivery path before I change anything.",
    looks: [
      call("hero-tool-api-glob", "Glob", { pattern: "src/api/**/*.ts" }),
      call("hero-tool-api-retry", "Read", { file_path: "/u/src/billing/src/billing/retry.ts" }),
      call("hero-tool-api-routes", "Grep", { pattern: "router\\.post", path: "src/api" }),
    ],
    lookResults: [
      { tool_use_id: "hero-tool-api-routes", content: "src/api/routes.ts:14:router.post(\"/v2/hooks\", createHook);\nsrc/api/routes.ts:15:router.post(\"/v2/hooks/:id/replay\", replayHook);" },
      { tool_use_id: "hero-tool-api-glob", content: "src/api/hooks.ts\nsrc/api/routes.ts\nsrc/api/auth.ts\nsrc/api/errors.ts" },
      { tool_use_id: "hero-tool-api-retry", content: "export const MAX_ATTEMPTS = 5;\nexport async function deliver(hook: Webhook, attempt = 1) {\n  try {\n    await post(hook.url, hook.body);\n  } catch (err) {\n    if (attempt >= MAX_ATTEMPTS) return deadLetter(hook, err);\n  }\n}" },
    ],
    plan: "I'll add the retry route next to the webhook handlers and reuse deliver() for each attempt.",
    seed: call("hero-tool-api-open", "Read", { file_path: "/u/src/billing/src/api/hooks.ts" }),
    seedResult: { tool_use_id: "hero-tool-api-open", content: "export async function handleHook(hook: Webhook) {\n  await deliver(hook);\n}" },
    tool: call("hero-tool-api-read", "Bash", { command: "rg -n \"deliver\\(\" src/api" }),
    result: { tool_use_id: "hero-tool-api-read", content: "src/api/hooks.ts:88:    await deliver(hook);\nsrc/api/hooks.ts:131:  return deliver(hook, attempt);" },
  },
  ui: {
    task: UI_TASK,
    model: "composer-2",
    look: "Checking how the failed deliveries view is built and what the API hands it.",
    looks: [
      call("hero-tool-ui-glob", "Glob", { pattern: "web/src/webhooks/*" }),
      call("hero-tool-ui-api", "Read", { file_path: "/u/src/billing/web/src/api/webhooks.ts" }),
      call("hero-tool-ui-row", "Read", { file_path: "/u/src/billing/web/src/webhooks/WebhookRow.tsx" }),
    ],
    lookResults: [
      { tool_use_id: "hero-tool-ui-row", content: "export function WebhookRow({ hook }: { hook: Webhook }) {\n  return <Row cells={[hook.url, hook.status, ago(hook.failedAt)]} />;\n}" },
      { tool_use_id: "hero-tool-ui-glob", content: "web/src/webhooks/FailedList.tsx\nweb/src/webhooks/WebhookRow.tsx\nweb/src/webhooks/index.ts" },
      { tool_use_id: "hero-tool-ui-api", content: "export const listFailed = () => get<Webhook[]>(\"/v2/hooks?status=failed\");\nexport const retryHook = (id: string) => post(`/v2/hooks/${id}/retry`);" },
    ],
    plan: "I'll put a Retry button on each failed row, with the attempt count and the last error beside it.",
    seed: call("hero-tool-ui-grep", "Grep", { pattern: "FailedList", path: "web/src" }),
    seedResult: { tool_use_id: "hero-tool-ui-grep", content: "web/src/webhooks/FailedList.tsx\nweb/src/webhooks/index.ts" },
    tool: call("hero-tool-ui-read", "Read", { file_path: "/u/src/billing/web/src/webhooks/FailedList.tsx" }),
    result: { tool_use_id: "hero-tool-ui-read", content: "export function FailedList({ hooks }: { hooks: Webhook[] }) {\n  return <Table rows={hooks} columns={COLUMNS} />;\n}" },
  },
};

export const WORKER_SESSIONS = { api: SESSIONS.api, ui: SESSIONS.ui };

export const entities: Record<string, EntityFixture> = {};
