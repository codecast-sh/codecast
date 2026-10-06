// Clay's side of a build, free of Convex: the file tools over a draft, the
// model run, and how it ended. run.ts feeds it a job and reports the result;
// tests drive it with scripted model turns.
import { defineTool, runAssistant, Type, type RunAssistantOptions, type RunResult } from "@platform/agent";
import { BUILD_CEILING_USD, BUILD_DEADLINE_MS, BUILD_FINISH_ATTEMPTS } from "../lib/limits";
import { BUILDER_MODEL, BUILDER_SYSTEM, finishProblems } from "../prompts";
import { Draft, DraftError, draftProblems } from "./draft";
import { Narration, stepLine, type Outcome } from "./rules";

const about = Type.Optional(Type.String({ description: "A few plain words for the people watching, e.g. \"Adding a reset button\"." }));

/** The agent's file tools over `draft`. finish and decline settle `outcome`
 *  and end the run. */
function builderTools(draft: Draft, narration: Narration, settle: (outcome: Outcome) => void, changed: () => void) {
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
          narration.say(`Looking at ${path}`);
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
          narration.say(stepLine(verb, path, about));
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
          narration.say(stepLine("Editing", path, about));
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
          narration.say(stepLine("Removing", path, about));
          return out;
        }),
    }),
    defineTool({
      name: "finish",
      description:
        "Checks the draft and, when it passes, puts it live for everyone. Call it alone, after your edits, with a one-line summary of what changed.",
      parameters: Type.Object({
        summary: Type.String({ description: "Present tense, for people: \"Adds a reset button under the score\"." }),
        ideas: Type.Optional(
          Type.Array(Type.String(), {
            description: "Three short changes people might ask for next, a few words each, specific to this app: \"make the frogs harmonize\".",
          }),
        ),
      }),
      risk: "write",
      run: async ({ summary, ideas }) => {
        if (!draft.changed()) throw new Error("Nothing has changed yet. Make the change first, or call decline if you will not.");
        const problems = draftProblems(draft.snapshot());
        if (problems.length) {
          finishTries++;
          const left = BUILD_FINISH_ATTEMPTS - finishTries;
          narration.say(left > 0 ? "Fixing a problem the check found" : "The check still fails, stopping");
          changed();
          if (left <= 0) settle({ kind: "invalid", problems });
          throw new Error(finishProblems(problems, left));
        }
        narration.say("Checked, going live");
        settle({ kind: "finished", summary, ...(ideas?.length ? { ideas } : {}) });
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

/** The newest line of a streamed model message, for the card. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
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
  apiKeys?: RunAssistantOptions["apiKeys"];
  sessionId?: string;
};

/** Run Clay on the draft until finish or decline settles it, or the run
 *  stops (time, money, an error). The draft holds the result. */
export async function runBuilder(run: AgentRun): Promise<{ outcome: Outcome; costUsd: number }> {
  let outcome: Outcome | null = null;
  const settle = (o: Outcome) => {
    outcome ??= o;
    run.controller.abort();
  };
  const result = await runAssistant({
    model: run.model ?? BUILDER_MODEL,
    system: BUILDER_SYSTEM,
    history: [{ role: "user", content: run.prompt }],
    tools: builderTools(run.draft, run.narration, settle, run.onStep),
    gate: () => "allow",
    ceilingUsd: BUILD_CEILING_USD,
    deadlineMs: BUILD_DEADLINE_MS,
    ...(run.apiKeys ? { apiKeys: run.apiKeys } : {}),
    signal: run.controller.signal,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    onText: (text, { messageUuid }) => {
      run.narration.stream(messageUuid, lastLine(text));
      run.onStep();
    },
  });
  return { outcome: (outcome as Outcome | null) ?? stoppedOutcome(result), costUsd: result.costUsd };
}
