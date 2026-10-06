// The hosted assistant's codecast tools (plan pl-840): the person's tasks,
// docs, routines and memory. Each calls one internal function in
// workspace.ts as the conversation's owner, so it runs the web's own path and
// stays inside the person's own workspace.
//
// Risk: changes to the person's own tasks, docs and memory are "read", like a
// draft, since only the person sees them and each is easy to undo: tasks keep
// their history, and a doc is only created or added to. A row someone else can
// see (a task synced with an issue, a task or doc shared by link, or in a plan
// or project shared by link) is refused by those tools (workspace.publicCopy).
// remember asks instead once mail, calendar, the web, or a task or doc is in
// front of the model (index.readOutsideContent). Replacing a doc's text keeps no copy
// of the old one, so replace_doc is "write" and asks.
// Scheduling a routine is "write": it spends the person's usage later,
// unattended. Cancelling one only stops spending, so it is "read".
//
// Docs, tasks and the memory doc can hold text that came from outside (a
// synced issue, a pasted email, a fact remembered while reading mail), so the
// tools that return them declare source "workspace" and the harness fences
// that text as data.
import { defineTool, Type, type Tool } from "@platform/agent";
import { ROUTINE_MIN_INTERVAL_MS } from "@codecast/shared/contracts/assistant";
import { TASK_PRIORITIES, TASK_STATUS_CATEGORIES } from "@codecast/shared/tasks";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { MEMORY_DOC_TITLE, TASK_LIST_FILTERS } from "./workspace";
import { instant, NEVER, WHOLE_TOOL, type AllowScopes } from "@platform/assistant";

/** The sourced codecast tools whose results hold only text the person
 *  approved: the memory doc, which grows through remember's gate or an
 *  approved replace_doc, and routine titles, set through schedule_routine's
 *  gate. Every other sourced tool counts as outside content: a task or doc
 *  can hold text others wrote (a synced issue, a pasted email) or that the
 *  assistant wrote without asking while mail was in front of it. */
export const PERSON_APPROVED_TOOLS: ReadonlySet<string> = new Set(["recall", "list_routines"]);

/** How an Always allow narrows for each codecast tool (@platform/assistant
 *  rules). A routine's prompt comes back later as the person's own words, and
 *  docs keep no old versions, so both always ask; appending to a doc and
 *  recall stay in the person's own workspace, so one rule covers the tool. */
export const CODECAST_SCOPES: AllowScopes = {
  schedule_routine: () => NEVER,
  write_doc: () => WHOLE_TOOL,
  replace_doc: () => NEVER,
  recall: () => WHOLE_TOOL,
};

/** What the codecast tools need from the turn action. */
export interface CodecastDeps {
  runQuery: (ref: any, args: any) => Promise<any>;
  runMutation: (ref: any, args: any) => Promise<any>;
  userId: Id<"users">;
  conversationId: Id<"conversations">;
}

const ops = internal.assistant.tools.workspace;

const json = (value: unknown) => JSON.stringify(value, null, 1);
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((v) => Type.Literal(v)));

export function codecastTools(deps: CodecastDeps): Tool[] {
  const user = { user_id: deps.userId };
  const here = { ...user, conversation_id: deps.conversationId };
  return [
    defineTool({
      name: "list_tasks",
      label: "Check tasks",
      description: "List the person's own tasks in codecast, most recently changed first: open ones by default, or finished ones (done or dropped), or all.",
      parameters: Type.Object({
        filter: Type.Optional(literals(TASK_LIST_FILTERS)),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      risk: "read",
      source: "workspace",
      run: async ({ filter, limit }) => {
        const tasks = await deps.runQuery(ops.listTasks, { ...user, filter, limit });
        return { content: tasks.length ? json(tasks) : "No tasks.", details: { tasks: tasks.length } };
      },
    }),
    defineTool({
      name: "create_task",
      label: "Add a task",
      description: "Add a task to the person's own task list in codecast.",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(literals(TASK_PRIORITIES)),
      }),
      risk: "read",
      run: async (args) => {
        const { id } = await deps.runMutation(ops.createTask, { ...user, ...args });
        return { content: `Added task ${id}: ${args.title}`, details: { task_id: id } };
      },
    }),
    defineTool({
      name: "update_task",
      label: "Update a task",
      description: "Change one of the person's own tasks: its title, notes, priority, or status (done closes it, dropped abandons it). A task linked to a GitHub or Linear issue, or shared by link, cannot be changed here.",
      parameters: Type.Object({
        id: Type.String({ description: "The task id from list_tasks, like ct-123." }),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        status: Type.Optional(literals(TASK_STATUS_CATEGORIES)),
        priority: Type.Optional(literals(TASK_PRIORITIES)),
      }),
      risk: "read",
      run: async (args) => {
        const after = await deps.runMutation(ops.updateTask, { ...user, ...args });
        return { content: `Updated task ${after.id}: ${after.status}, ${after.priority} priority.`, details: { task_id: after.id } };
      },
    }),
    defineTool({
      name: "read_doc",
      label: "Read a note",
      description: "Read one of the person's own docs in codecast, by id or by words from its title. Returns the best match in full and names the other matches.",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        query: Type.Optional(Type.String({ description: "Words from the doc's title." })),
      }),
      risk: "read",
      source: "workspace",
      run: async (args) => {
        const doc = await deps.runQuery(ops.readDoc, { ...user, ...args });
        if (!doc.found) return { content: `No doc of yours has a title matching "${args.query}".`, details: { found: false } };
        const others = doc.others.length ? `\n\nOther matches: ${doc.others.map((o: any) => `${o.title} (${o.id})`).join("; ")}` : "";
        return {
          content: `Doc ${doc.id}: ${doc.title} (updated ${doc.updated})\n\n${doc.content}${doc.truncated ? "\n[cut: the doc goes on]" : ""}${others}`,
          details: { doc_id: doc.id },
        };
      },
    }),
    defineTool({
      name: "write_doc",
      label: "Write a note",
      description:
        "Write in the person's own codecast docs. Without an id it creates a new doc (a title is needed). With an id it adds the text to the end of that doc. " +
        "To rewrite a doc's existing text, or to add to a doc shared by link, use replace_doc.",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String({ description: "The new doc's title." })),
        content: Type.String({ description: "Markdown." }),
      }),
      risk: "read",
      run: async ({ id, title, content }) => {
        const done = await deps.runMutation(ops.writeDoc, { ...user, content, ...(id ? { id, append: true } : { title }) });
        return { content: `${done.created ? "Created" : "Added to"} doc ${done.id}.`, details: { doc_id: done.id } };
      },
    }),
    defineTool({
      name: "replace_doc",
      label: "Rewrite a note",
      description: "Replace the whole text of one of the person's own codecast docs, by its id. The old text is not kept, so the person approves the new text first.",
      parameters: Type.Object({
        id: Type.String(),
        content: Type.String({ description: "The doc's new text in full, Markdown." }),
        title: Type.Optional(Type.String({ description: "A new title, if it changes." })),
      }),
      risk: "write",
      run: async ({ id, content, title }) => {
        const done = await deps.runMutation(ops.writeDoc, { ...user, id, content, ...(title ? { title } : {}) });
        return { content: `Rewrote doc ${done.id}.`, details: { doc_id: done.id } };
      },
    }),
    defineTool({
      name: "remember",
      label: "Remember",
      description:
        `Remember one lasting fact about the person (a preference, a person in their life, how they like things done) in their "${MEMORY_DOC_TITLE}" doc, ` +
        "which they can read and edit. One short fact per call. Never store passwords, codes or other secrets.",
      parameters: Type.Object({ fact: Type.String() }),
      risk: "read",
      run: async ({ fact }) => {
        const { doc_id } = await deps.runMutation(ops.remember, { ...user, fact });
        return { content: "Remembered.", details: { doc_id } };
      },
    }),
    defineTool({
      name: "recall",
      label: "Recall",
      description: `Read everything remembered about the person (their "${MEMORY_DOC_TITLE}" doc).`,
      parameters: Type.Object({}),
      risk: "read",
      source: "workspace",
      run: async () => {
        const { content, doc_id } = await deps.runQuery(ops.recall, user);
        return { content: content.trim() ? content : "Nothing remembered yet.", details: { doc_id } };
      },
    }),
    defineTool({
      name: "schedule_routine",
      label: "Set a routine",
      description:
        "Set a routine: an instruction this conversation carries out at a time, once or repeating. When it fires, the instruction arrives here as a message and you do the work then. " +
        "Write the instruction so it stands on its own. " +
        "A routine repeats at one fixed interval from its first run and nothing else: it cannot skip days, so on its own it cannot run on weekdays only or leave out holidays. " +
        "For certain days of the week, set one weekly routine for each of those days. Tell the person plainly what the schedule you set will do, and never say a routine will skip days.",
      parameters: Type.Object({
        instruction: Type.String({ description: "What to do each time, written as a request to yourself." }),
        title: Type.Optional(Type.String({ description: "A short name the person sees." })),
        first_run: Type.String({ description: "When it first runs, ISO 8601 with its UTC offset, like 2026-10-06T08:00:00-07:00. Every later run follows from it, so it must fall on the day asked for on the person's own calendar: for \"every Monday\", a date that is a Monday there. Work the weekday out from today's date before you write it." }),
        repeat_every_hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: `Repeat this often; 24 is daily, 168 weekly. Leave out for once. At least ${ROUTINE_MIN_INTERVAL_MS / 3_600_000}; the person's plan may set a longer floor.` })),
      }),
      risk: "write",
      run: async ({ instruction, title, first_run, repeat_every_hours }) => {
        const routine = await deps.runMutation(ops.scheduleRoutine, {
          ...here,
          prompt: instruction,
          ...(title ? { title } : {}),
          run_at: instant(first_run, "first_run"),
          ...(repeat_every_hours !== undefined ? { interval_ms: Math.round(repeat_every_hours * 3_600_000) } : {}),
        });
        return { content: `Routine set: ${json(routine)}`, details: { routine_id: routine.id } };
      },
    }),
    defineTool({
      name: "list_routines",
      label: "Check routines",
      description: "List the routines set on this conversation, with when each runs next.",
      parameters: Type.Object({}),
      risk: "read",
      // Titles are stored text the person can edit on the web.
      source: "workspace",
      run: async () => {
        const routines = await deps.runQuery(ops.listRoutines, here);
        return { content: routines.length ? json(routines) : "No routines on this conversation.", details: { routines: routines.length } };
      },
    }),
    defineTool({
      name: "cancel_routine",
      label: "Cancel a routine",
      description: "Cancel a routine on this conversation, by its id from list_routines.",
      parameters: Type.Object({ id: Type.String() }),
      risk: "read",
      run: async ({ id }) => {
        const result = await deps.runMutation(ops.cancelRoutine, { ...here, id });
        return { content: result.cancelled ? `Cancelled routine ${id}.` : `Routine ${id} was not running.`, details: result };
      },
    }),
  ];
}
