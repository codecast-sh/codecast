/**
 * Chapter 2, Steer (and chapter 3's spawns, which land in the same
 * transcript): the lead's messages, the session open before it, and the
 * working line's labels. Each entry carries its cue and the height it adds to
 * the transcript (px at the desk's width, measured), which the motion file
 * turns into the feed's `push` beats.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { ToolCall, ToolResult } from "@/components/conversation/types";
import { DESK } from "./desk";
import { CUES, MIN, OBJECTS, PEOPLE, PROMPT, SESSIONS } from "./story";

export type Entry = {
  key: string;
  kind: "user" | "assistant";
  /** Film second it lands. */
  cue: number;
  /** Height it adds to the transcript, px. */
  h: number;
  /** Seconds before `now` its timestamp reads. */
  ago: number;
  text?: string;
  thinking?: string;
  tool?: ToolCall;
  result?: ToolResult;
  /** The result arrives later (at testsPass): the entry grows then. */
  pendingUntil?: number;
  agent?: string;
  header?: boolean;
  /** Its own controls work (the Edit block collapses and expands). */
  live?: boolean;
};

const tool = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input: JSON.stringify(input) });

const RETRY_OLD = `export async function deliver(hook: Webhook) {
  await post(hook.url, hook.body);
}`;
const RETRY_NEW = `const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2 * 60_000;

export async function deliver(hook: Webhook, attempt = 1) {
  try {
    await post(hook.url, hook.body);
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) return deadLetter(hook, err);
    await retryQueue.add(hook, jitter(BASE_DELAY_MS * 2 ** (attempt - 1)));
  }
}`;

const spawnOut = (shortId: string, gist: string, where = "~/src/billing") =>
  `✓ spawned 1 session in ${where}, nested under ${SESSIONS.lead.shortId} as a subagent row:\n  ${shortId}  ${gist}`;

export const API_TASK = "Retry endpoint: POST /v2/hooks/retry, idempotent, 5 attempts max";
export const UI_TASK = "Dashboard: a retry button and attempt history on each failed webhook";

/** The lead's transcript, every entry it gains during the film, in order. */
export const ENTRIES: Entry[] = [
  { key: "prompt", kind: "user", cue: CUES.prompt, h: 117, ago: 50_000, text: PROMPT },
  {
    key: "thinking", kind: "assistant", cue: DESK.thinking, h: 216, ago: 44_000, agent: SESSIONS.lead.agent, header: true,
    thinking: "Failed deliveries are dropped today. A queue with exponential backoff keeps a flaky endpoint from losing events, and a cap stops a dead one from retrying forever.",
    text: "I'll put failed deliveries on a retry queue with exponential backoff, and send the ones that run out of attempts to a dead letter table.",
  },
  {
    key: "edit", kind: "assistant", cue: DESK.edit, h: 277, ago: 38_000, agent: SESSIONS.lead.agent, live: true,
    tool: tool("hero-tool-edit", "Edit", { file_path: "/u/src/billing/src/billing/retry.ts", old_string: RETRY_OLD, new_string: RETRY_NEW }),
    result: { tool_use_id: "hero-tool-edit", content: "The file src/billing/retry.ts has been updated." },
  },
  {
    key: "bash", kind: "assistant", cue: DESK.bash, h: 28, ago: 30_000, agent: SESSIONS.lead.agent, pendingUntil: CUES.testsPass,
    tool: tool("hero-tool-test", "Bash", { command: "bun test src/billing", description: "Run the billing tests" }),
    result: { tool_use_id: "hero-tool-test", content: "src/billing/retry.test.ts:\n✓ retries with exponential backoff\n✓ dead-letters after the last attempt\n\n 212 pass\n 0 fail\nRan 212 tests across 18 files. [3.41s]" },
  },
  { key: "steer", kind: "user", cue: DESK.steerSent, h: 117, ago: 18_000, text: "keep the max at 5 attempts" },
  {
    key: "ack", kind: "assistant", cue: DESK.ack, h: 96, ago: 12_000, agent: SESSIONS.lead.agent,
    text: "212 tests pass. MAX_ATTEMPTS is 5 now. I'll split the rest between two workers: the retry endpoint and the dashboard.",
  },
  {
    key: "spawnA", kind: "assistant", cue: CUES.spawnA, h: 30, ago: 8_000, agent: SESSIONS.lead.agent,
    tool: tool("hero-tool-spawnA", "Bash", { command: `cast spawn --subagent --cloud --agent codex -- "${API_TASK}"` }),
    result: { tool_use_id: "hero-tool-spawnA", content: spawnOut(SESSIONS.api.shortId, API_TASK, `~/src/billing on ${OBJECTS.hosts.cloud}`) },
  },
  {
    key: "spawnB", kind: "assistant", cue: CUES.spawnB, h: 30, ago: 7_000, agent: SESSIONS.lead.agent,
    tool: tool("hero-tool-spawnB", "Bash", { command: `cast spawn --subagent --agent cursor -- "${UI_TASK}"` }),
    result: { tool_use_id: "hero-tool-spawnB", content: spawnOut(SESSIONS.ui.shortId, UI_TASK) },
  },
];

/** How much taller the test run gets when its result arrives, px. */
export const TESTS_DONE_H = 0;

/** The session open in the pane before the lead takes the selection: the first inbox row. */
export const PREV = {
  title: "Migrate invoices to Postgres 16",
  agent: "codex",
  model: "gpt-5.5-codex",
  age: 42 * MIN,
  messages: 41,
  entries: [
    { key: "prev-q", kind: "user", cue: 0, h: 0, ago: 3 * MIN, text: "run the migration against staging first" },
    {
      key: "prev-a", kind: "assistant", cue: 0, h: 0, ago: 2 * MIN, agent: "codex", header: true,
      text: "Staging is on Postgres 16. All 1.2M invoices copied and checksummed; the old cluster stays read-only until you say so.",
    },
  ] satisfies Entry[],
};

export const VIEWER = {
  model: "claude-opus-4-5",
  sarah: { _id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, presence_state: "active" },
};

/** Sarah opens the lead while it runs the tests. */
export const SARAH_VIEWING = DESK.bash + 0.4;

/** What the working line says the lead is doing. */
export const workingLabel = (t: number) =>
  t >= CUES.spawnA ? "spawning workers"
    : t >= DESK.steerSent ? "reading your message"
      : t >= CUES.testsPass ? "tests passed"
        : t >= DESK.bash ? "running bun test"
          : t >= DESK.edit ? "editing retry.ts"
            : "thinking";

export const entities: Record<string, EntityFixture> = {};
