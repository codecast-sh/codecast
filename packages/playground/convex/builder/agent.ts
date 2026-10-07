// Clay's side of a build, free of Convex: the file tools over a draft, the
// model run, and how it ended. run.ts feeds it a job and reports the result;
// tests drive it with scripted model turns.
import { defineTool, runAssistant, Type, type RunAssistantOptions, type RunResult } from "@platform/agent";
import { BUILD_CEILING_USD, BUILD_DEADLINE_MS, BUILD_FINISH_ATTEMPTS, SPOTLIGHT_MAX, TRY_MAX } from "../lib/limits";
import { clipLine } from "../lib/text";
import { BUILDER_EFFORT, BUILDER_MODEL, BUILDER_SYSTEM, finishProblems } from "../prompts";
import { Draft, DraftError, draftProblems } from "./draft";
import { clayModel, type Effort } from "./model";
import { Narration, fileName, stepLine, thinkingLine, type Outcome } from "./rules";

const about = Type.Optional(Type.String({ description: "A few plain words for the people watching, e.g. \"Adding a reset button\"." }));

/** The agent's file tools over `draft`. finish and decline settle `outcome`
 *  and end the run. */
function builderTools(draft: Draft, narration: Narration, settle: (outcome: Outcome) => void, changed: () => void, checked: (ms: number) => void) {
  let finishTries = 0;
  // A tool's mistake goes back to the model as its error; anything else is a bug.
  const step = (fn: () => string) => {
    try {
      const out = fn();
      changed();
      return out;
    } catch (e) {
      if (e instanceof DraftError) throw new Error(e.message);
      throw e;
    }
  };

  return [
    defineTool({
      name: "list_files",
      description: "Lists every file in the draft with its size.",
      parameters: Type.Object({}),
      risk: "read",
      run: async () => draft.list(),
    }),
    defineTool({
      name: "read_file",
      description: "Returns one file's full text.",
      parameters: Type.Object({ path: Type.String() }),
      risk: "read",
      run: async ({ path }) =>
        step(() => {
          narration.now(`Reading ${fileName(path)}`);
          return draft.read(path);
        }),
    }),
    defineTool({
      name: "write_file",
      description: "Creates a file or replaces its whole text.",
      parameters: Type.Object({ path: Type.String(), content: Type.String(), about }),
      risk: "write",
      run: async ({ path, content, about }) =>
        step(() => {
          const verb = draft.has(path) ? "Rewriting" : "Creating";
          const out = draft.write(path, content);
          narration.change(path, stepLine(verb, path, about));
          return out;
        }),
    }),
    defineTool({
      name: "edit_file",
      description:
        "Replaces old_text with new_text in a file. old_text must match exactly, whitespace included, and appear once unless all is true.",
      parameters: Type.Object({
        path: Type.String(),
        old_text: Type.String(),
        new_text: Type.String(),
        all: Type.Optional(Type.Boolean({ description: "Replace every occurrence." })),
        about,
      }),
      risk: "write",
      run: async ({ path, old_text, new_text, all, about }) =>
        step(() => {
          const out = draft.edit(path, old_text, new_text, all);
          narration.change(path, stepLine("Editing", path, about));
          return out;
        }),
    }),
    defineTool({
      name: "delete_file",
      description: "Deletes a file. index.html cannot be deleted.",
      parameters: Type.Object({ path: Type.String(), about }),
      risk: "write",
      run: async ({ path, about }) =>
        step(() => {
          const out = draft.remove(path);
          narration.change(path, stepLine("Removing", path, about));
          return out;
        }),
    }),
    defineTool({
      name: "finish",
      description:
        "Checks the draft and, when it passes, puts it live for everyone. Call it alone, after your edits, with a one-line summary of what changed.",
      parameters: Type.Object({
        summary: Type.String({ description: "Present tense, for people: \"Adds a reset button under the score\". On a first build, what the app is: \"A shared grocery list for the flat\"." }),
        name: Type.Optional(
          Type.String({ description: "A new app's first build only: the app's name, as its own title shows it (\"Flat groceries\")." }),
        ),
        spotlight: Type.Optional(
          Type.String({
            description:
              "A CSS selector for the one element on screen this change is about, as your code renders it (\"#score\", \".bass-frog\"), so the room sees where it landed. Leave it out when the change has no single place.",
          }),
        ),
        try: Type.Optional(
          Type.String({
            description: "When people only notice the change by doing something, a few words telling them what to do: \"Tap any note\". Leave it out otherwise.",
          }),
        ),
        ideas: Type.Optional(
          Type.Array(Type.String(), {
            description: "Three short changes people might ask for next, a few words each, specific to this app: \"make the frogs harmonize\".",
          }),
        ),
      }),
      risk: "write",
      run: async ({ summary, name, ideas, spotlight, try: tryIt }) => {
        if (!draft.changed()) throw new Error("Nothing has changed yet. Make the change first, or call decline if you will not.");
        const start = Date.now();
        const problems = draftProblems(draft.snapshot());
        checked(Date.now() - start);
        if (problems.length) {
          finishTries++;
          const left = BUILD_FINISH_ATTEMPTS - finishTries;
          narration.say(left > 0 ? "Fixing a problem the check found" : "The check still fails, stopping");
          changed();
          if (left <= 0) settle({ kind: "invalid", problems });
          throw new Error(finishProblems(problems, left));
        }
        narration.say("Checked, going live");
        const where = clipLine(spotlight ?? "", SPOTLIGHT_MAX);
        const tryLine = clipLine(tryIt ?? "", TRY_MAX).replace(/[.!]+$/, "");
        settle({ kind: "finished", summary, ...(name ? { name } : {}), ...(ideas?.length ? { ideas } : {}), ...(where ? { spotlight: where } : {}), ...(tryLine ? { try: tryLine } : {}) });
        return "Accepted. It is going live now.";
      },
    }),
    defineTool({
      name: "decline",
      description: "Stops without changing the app. The reason is shown to the room, so write it as one friendly sentence.",
      parameters: Type.Object({ reason: Type.String() }),
      risk: "read",
      run: async ({ reason }) => {
        settle({ kind: "declined", reason });
        return "Declined.";
      },
    }),
  ];
}

/** How a run ended when no tool settled it. */
function stoppedOutcome(result: RunResult): Outcome {
  return { kind: "stopped", reason: result.reason, ...(result.error ? { error: result.error } : {}) };
}

export type AgentRun = {
  draft: Draft;
  narration: Narration;
  /** The build request message (buildPrompt). */
  prompt: string;
  /** Called after every step, so the card can be written. */
  onStep: () => void;
  /** Aborting stops the run; the run aborts it itself once a tool settles. */
  controller: AbortController;
  model?: RunAssistantOptions["model"];
  /** How hard Clay thinks; a change's by default. */
  effort?: Effort;
  apiKeys?: RunAssistantOptions["apiKeys"];
  sessionId?: string;
};

/** Run Clay on the draft until finish or decline settles it, or the run
 *  stops (time, money, an error). The draft holds the result. */
export async function runBuilder(run: AgentRun): Promise<{ outcome: Outcome; costUsd: number; checkMs: number }> {
  let outcome: Outcome | null = null;
  let checkMs = 0;
  const settle = (o: Outcome) => {
    outcome ??= o;
    run.controller.abort();
  };
  const result = await runAssistant({
    model:
      run.model ??
      clayModel(BUILDER_MODEL, {
        effort: run.effort ?? BUILDER_EFFORT.change,
        onThinking: (summary) => {
          run.narration.now(thinkingLine(summary));
          run.onStep();
        },
      }),
    system: BUILDER_SYSTEM,
    history: [{ role: "user", content: run.prompt }],
    tools: builderTools(run.draft, run.narration, settle, run.onStep, (ms) => (checkMs += ms)),
    gate: () => "allow",
    ceilingUsd: BUILD_CEILING_USD,
    deadlineMs: BUILD_DEADLINE_MS,
    ...(run.apiKeys ? { apiKeys: run.apiKeys } : {}),
    signal: run.controller.signal,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    onText: (text, { messageUuid }) => {
      run.narration.stream(messageUuid, text);
      run.onStep();
    },
  });
  return { outcome: (outcome as Outcome | null) ?? stoppedOutcome(result), costUsd: result.costUsd, checkMs };
}
