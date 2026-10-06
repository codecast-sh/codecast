// One build's run: Clay works on an in-memory draft of the base version with
// file tools, narrating to the build card as it goes, and the draft becomes
// the new live version once finish accepts it (queue.finish).
import { defineTool, runAssistant, Type, type RunResult } from "@platform/agent";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { byteLength } from "../lib/files";
import { BUILD_CEILING_USD, BUILD_DEADLINE_MS, BUILD_FINISH_ATTEMPTS, BUILD_INLINE_FILES_BYTES } from "../lib/limits";
import { BUILDER_MODEL, BUILDER_SYSTEM, buildPrompt, finishProblems } from "../prompts";
import { Draft, DraftError, draftProblems } from "./draft";
import { Narration, Throttle, failureFor, stepLine, type Outcome } from "./rules";

/** How often the card's narration is written while the agent works. */
const NARRATE_EVERY_MS = 250;

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
      parameters: Type.Object({ summary: Type.String({ description: "Present tense, for people: \"Adds a reset button under the score\"." }) }),
      risk: "write",
      run: async ({ summary }) => {
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
        settle({ kind: "finished", summary });
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

export const build = internalAction({
  args: { build_id: v.id("builds") },
  handler: async (ctx, { build_id }): Promise<null> => {
    const narration = new Narration();
    let draft = new Draft([]);
    let cost = 0;
    const report = (result: { ok: true; summary: string; files: { path: string; text: string }[] } | { ok: false; error: string; detail: string }) =>
      ctx.runMutation(internal.builder.queue.finish, {
        build_id,
        cost_usd: cost,
        narration: narration.view(),
        files_touched: draft.touched(),
        result,
      });

    try {
      const job = await ctx.runQuery(internal.builder.queue.job, { build_id });
      if (!job) return null;
      draft = new Draft(await ctx.runQuery(internal.versions.draft, { app_id: job.app_id, number: job.base }));
      narration.say(`Reading v${job.base}`);

      const controller = new AbortController();
      const throttle = new Throttle(async () => {
        const live = await ctx.runMutation(internal.builder.queue.progress, {
          build_id,
          narration: narration.view(),
          files_touched: draft.touched(),
        });
        if (!live) controller.abort();
      }, NARRATE_EVERY_MS);
      throttle.poke();

      let outcome: Outcome | null = null;
      const settle = (o: Outcome) => {
        outcome ??= o;
        controller.abort();
      };
      const files = draft.snapshot();
      const inline = files.reduce((n, f) => n + byteLength(f.text), 0) <= BUILD_INLINE_FILES_BYTES;

      const result = await runAssistant({
        model: BUILDER_MODEL,
        system: BUILDER_SYSTEM,
        history: [{ role: "user", content: buildPrompt({ ...job, app: job.app_name, files: inline ? files : null, listing: draft.list() }) }],
        tools: builderTools(draft, narration, settle, () => throttle.poke()),
        gate: () => "allow",
        ceilingUsd: BUILD_CEILING_USD,
        deadlineMs: BUILD_DEADLINE_MS,
        apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
        signal: controller.signal,
        sessionId: `build:${job.app_id}`,
        onText: (text, { messageUuid }) => {
          narration.stream(messageUuid, lastLine(text));
          throttle.poke();
        },
        onMessage: (_row, { costUsd }) => {
          cost += costUsd;
        },
      });
      cost = result.costUsd;
      await throttle.flush();

      const end: Outcome = outcome ?? stoppedOutcome(result);
      if (end.kind === "finished") await report({ ok: true, summary: end.summary, files: draft.snapshot() });
      else await report({ ok: false, ...failureFor(end) });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await report({ ok: false, ...failureFor({ kind: "stopped", reason: "error", error: detail }) });
    }
    return null;
  },
});
