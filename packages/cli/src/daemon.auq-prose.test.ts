import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { extractAssistantProseAbovePrompt, sidecarMatchesScrape, resolveInteractiveQuestions, parseInteractivePrompt } from "./daemon.js";

// A turn that ends in AskUserQuestion is buffered out of the JSONL until answered, so the
// reasoning that motivates the question lives ONLY in the rendered pane while it waits.
// extractAssistantProseAbovePrompt pulls that prose back so the web question card can show
// *why* it's being asked. These guard the boundary detection that keeps it from grabbing
// the dialog chrome, the options, or a previous turn.

describe("extractAssistantProseAbovePrompt", () => {
  test("real captured pane: extracts only the question's own prose", () => {
    // A live AskUserQuestion pane captured from `tmux capture-pane`. The prose for THIS
    // question is the "Kill all is destructive…" block; everything above the ❯ user line
    // is a *prior* turn (with its own ★ Insight block — a decoy separator), and everything
    // below the full-width rule is the dialog itself.
    const pane = fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "auq-pane-killall.txt"), "utf8");
    const prose = extractAssistantProseAbovePrompt(pane);

    expect(prose).toMatch(/^"Kill all" is a destructive/);
    expect(prose).toContain("every page");
    expect(prose).toMatch(/a confirm step regardless\.$/);

    // Not the prior turn, not its insight block, not the dialog, not the options.
    expect(prose).not.toContain("Deploy status");
    expect(prose).not.toContain("The win here was resisting");
    expect(prose).not.toContain("Where should the");
    expect(prose).not.toContain("Global, every route");
    expect(prose).not.toContain("Chat about this");
    // The bullet glyph and the dialog's full-width rule must be stripped out.
    expect(prose).not.toContain("⏺");
    expect(prose).not.toMatch(/─{40}/);
  });

  test("long multi-paragraph prose with an inner Insight block is kept whole", () => {
    const pane = [
      "❯ whats up with these unparented subagents in my inbox?",
      "",
      "⏺ The cards in your screenshot are orchestration workers, not real subagents.",
      "  Here is why they land unparented.",
      "",
      "  The daemon does auto-parent in three cases, and these miss all three:",
      "  1. Task-tool subagents — detected from the parent's transcript sidechain.",
      "  2. Plan-handoff forks — parent_message_uuid plan-handoff. Not a fork.",
      "  3. tmux spawns via agent-spawn.sh from a watched parent — claude-only.",
      "",
      "  ★ Insight ─────────────────────────────────────",
      "  - The system records parentage two incompatible ways.",
      "  - Auto-parenting is a pile of best-effort heuristics, not a guarantee.",
      "  ─────────────────────────────────────────────────",
      "",
      "  Confidence: ~95%. The launch path is confirmed in code and logs.",
      "",
      "──────────────────────────────────────────────────────────────────────────────────────",
      "□ Fix approach",
      "",
      "Want me to fix the inbox clutter from orchestration workers, and which way?",
      "",
      "  1. Group under their plan          Client-side: nest plan workers under a group.",
      " 2. Link workers at spawn            Server-side: stamp the parent link at spawn.",
      "  3. Hide worktree workers           Treat worktree binding as subagent-like.",
      "",
      "──────────────────────────────────────────────",
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");

    // Sanity: the menu must parse, and to the REAL options (not the "1./2./3." in the prose).
    const parsed = parseInteractivePrompt(pane);
    expect(parsed?.question).toContain("fix the inbox clutter");
    expect(parsed?.options.map(o => o.label)).toContain("Group under their plan");

    const prose = extractAssistantProseAbovePrompt(pane);
    expect(prose).toMatch(/^The cards in your screenshot/);
    expect(prose).toContain("auto-parent in three cases");
    expect(prose).toContain("1. Task-tool subagents");       // numbered list INSIDE prose survives
    expect(prose).toContain("★ Insight");
    expect(prose).toContain("Auto-parenting is a pile");
    expect(prose).toMatch(/Confidence: ~95%.*logs\.$/s);     // ends at the last prose line

    // Must stop at the dialog: no chip, no question, no options, no full-width rule.
    expect(prose).not.toContain("Fix approach");
    expect(prose).not.toContain("Want me to fix");
    expect(prose).not.toContain("Group under their plan");
    expect(prose).not.toContain("Chat about this");
    expect(prose).not.toContain("─".repeat(60));             // the 49-dash Insight rules are fine; the dialog rule is not
  });

  test("returns empty for a bare slash menu with no preceding assistant prose", () => {
    const pane = [
      "  some earlier non-bulleted output",
      "",
      "─────────────────────────────────────────",
      "Select a model to use",
      "",
      "  1. Default",
      "  2. Opus",
      "",
      "Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(extractAssistantProseAbovePrompt(pane)).toBe("");
  });

  test("returns empty for a confirmation prompt", () => {
    const pane = [
      "⏺ I'm about to delete the file.",
      "",
      "Press Enter to continue, Esc to cancel",
    ].join("\n");
    const parsed = parseInteractivePrompt(pane);
    expect(parsed?.isConfirmation).toBe(true);
    expect(extractAssistantProseAbovePrompt(pane)).toBe("");
  });

  test("returns empty when there is no menu at all", () => {
    expect(extractAssistantProseAbovePrompt("just some text\nno menu here")).toBe("");
  });
});

describe("sidecarMatchesScrape", () => {
  test("matches when the first question lines up (ignoring glyph/wrap noise)", () => {
    const questions = [{ question: "Where should the \"kill all\" button live, and what should it target?" }];
    expect(sidecarMatchesScrape(questions, "Where should the kill all button live, and what should it target?")).toBe(true);
  });

  test("rejects a stale sidecar for a different question", () => {
    const questions = [{ question: "Pick a deployment target for the release" }];
    expect(sidecarMatchesScrape(questions, "Where should the kill all button live?")).toBe(false);
  });

  test("rejects empty / malformed sidecar questions", () => {
    expect(sidecarMatchesScrape([], "anything at all here")).toBe(false);
    expect(sidecarMatchesScrape([{}], "anything at all here")).toBe(false);
  });
});

describe("resolveInteractiveQuestions", () => {
  const pane = fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "auq-pane-killall.txt"), "utf8");

  test("uses the hook's full tool_input (with descriptions) when it matches the menu", () => {
    const prompt = parseInteractivePrompt(pane)!;
    const sidecar = {
      questions: [{
        question: prompt.question,
        header: "Scope",
        options: [
          { label: "Global, every route", description: "a panic button on every route" },
          { label: "Sessions page, all filters", description: "acts on the current filter" },
          { label: "Both", description: "" },
        ],
        multiSelect: true,
      }],
    };
    const out = resolveInteractiveQuestions(prompt, sidecar);
    expect(out).toBe(sidecar.questions);                          // full-fidelity wins
    expect(out[0].options[0].description).toBe("a panic button on every route");
    expect(out[0].multiSelect).toBe(true);
  });

  test("falls back to the scrape when there's no sidecar", () => {
    const prompt = parseInteractivePrompt(pane)!;
    const out = resolveInteractiveQuestions(prompt, null);
    expect(out[0].question).toBe(prompt.question);
    expect(out[0].options).toBe(prompt.options);
  });

  test("falls back to the scrape when the sidecar is for a different (stale) question", () => {
    const prompt = parseInteractivePrompt(pane)!;
    const out = resolveInteractiveQuestions(prompt, { questions: [{ question: "Pick a deploy target", options: [] }] });
    expect(out[0].question).toBe(prompt.question);                // not the stale "Pick a deploy target"
  });
});
