import { extractNestedActions, isPlanWriteToolCall, summarizeToolGroup, type ToolCallLike } from '@codecast/shared/render';

/**
 * Runs of tool calls in a transcript, folded to one "N steps" row each, the
 * way the web folds a turn's tools into a receipt. A run opens on an
 * assistant message whose calls are all routine (its text, if any, stays
 * above the row) and takes in every tool-only or thinking-only message after
 * it; anything
 * else that renders (a person's turn, a reply with words, a card-drawing
 * call like a todo list or a question) closes it.
 */

type RunMessage = {
  _id: string;
  role: string;
  content?: string | null;
  images?: unknown[] | null;
  thinking?: string | null;
  tool_calls?: (ToolCallLike & { id: string })[] | null;
};

/** Calls that draw their own card in the transcript; they stay visible and break a run. */
const CARD_TOOLS = new Set([
  'Task', 'AskUserQuestion', 'TodoWrite', 'TaskList', 'TaskCreate', 'TaskUpdate', 'TaskGet',
  'SendUserFile', 'SendMessage', 'TeamCreate', 'TeamDelete', 'Skill', 'EnterPlanMode', 'ExitPlanMode',
]);

export const isFoldableToolCall = (tc: ToolCallLike) => !CARD_TOOLS.has(tc.name) && !isPlanWriteToolCall(tc);

export type ToolRun = {
  /** The run's first message; its key is the run's. */
  head: string;
  members: string[];
  steps: number;
  summary: string;
};

/**
 * Each message in a folded run, by id. A lone call folds too: its row names
 * what ran ("ran npx tsc") where its own line shows the raw call. `skip`
 * names rows that never render (tool-result carriers) and so never break a run.
 */
export function foldToolRuns<M extends RunMessage>(messages: readonly M[], skip: (m: M) => boolean): Map<string, ToolRun> {
  const byId = new Map<string, ToolRun>();
  let open: { ids: string[]; actions: ToolCallLike[] } | null = null;
  const close = () => {
    if (open && open.actions.length > 0) {
      const run: ToolRun = { head: open.ids[0], members: open.ids, steps: open.actions.length, summary: summarizeToolGroup(open.actions) };
      for (const id of open.ids) byId.set(id, run);
    }
    open = null;
  };
  for (const m of messages) {
    if (skip(m)) continue;
    const calls = m.role === 'assistant' ? m.tool_calls ?? [] : [];
    // Reasoning between calls, stored as its own message, belongs to the run around it.
    const thinkingOnly = m.role === 'assistant' && calls.length === 0 && !m.content?.trim() && !!m.thinking?.trim() && !m.images?.length;
    if (!thinkingOnly && (calls.length === 0 || !calls.every(isFoldableToolCall) || (m.images?.length ?? 0) > 0)) {
      close();
      continue;
    }
    if (m.content?.trim() || !open) {
      close();
      open = { ids: [], actions: [] };
    }
    open!.ids.push(m._id);
    for (const tc of calls) {
      const nested = extractNestedActions(tc);
      open!.actions.push(...(nested.length > 0 ? nested : [tc]));
    }
  }
  close();
  return byId;
}
