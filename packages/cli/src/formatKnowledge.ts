// What `cast decisions` and `cast patterns` print.

import { truncateId } from "./formatter.js";

interface Decision {
  id: string;
  title: string;
  rationale: string;
  alternatives?: string[];
  tags?: string[];
  session_id?: string;
  conversation_id?: string;
  message_index?: number;
  project_path?: string;
  created_at: string;
}

interface DecisionsResult {
  decisions: Decision[];
  count: number;
}

export function formatDecisionsResults(result: DecisionsResult): string {
  const lines: string[] = [];

  lines.push(`<DECISIONS count=${result.count}>`);

  if (result.decisions.length === 0) {
    lines.push("No decisions found.");
    lines.push("</DECISIONS>");
    return lines.join("\n");
  }

  for (const decision of result.decisions) {
    const shortId = truncateId(decision.id);
    const date = new Date(decision.created_at).toISOString().split("T")[0];

    // Labelled, so the head of a Convex id never reads as another kind's short id.
    lines.push(`[decision ${shortId}] ${date} - ${decision.title}`);
    lines.push(`  Why: ${decision.rationale}`);

    if (decision.tags && decision.tags.length > 0) {
      lines.push(`  Tags: ${decision.tags.join(", ")}`);
    }

    // The conversation's short id is what `cast read` takes; session_id is the
    // agent's own uuid, which no command accepts, so a row without a
    // conversation names no session.
    if (decision.conversation_id) {
      const msgPart = decision.message_index !== undefined ? ` msg ${decision.message_index}` : "";
      lines.push(`  Session: ${truncateId(decision.conversation_id)}${msgPart}`);
    }

    lines.push("");
  }

  lines.push("</DECISIONS>");

  return lines.join("\n");
}

interface Pattern {
  id: string;
  name: string;
  description: string;
  content?: string;
  tags?: string[];
  source_session_id?: string;
  source_range?: string;
  usage_count: number;
  created_at: string;
}

interface PatternsListResult {
  patterns: Pattern[];
  count: number;
}

export function formatPatternsResults(result: PatternsListResult): string {
  const lines: string[] = [];

  lines.push(`<PATTERNS count=${result.count}>`);

  if (result.patterns.length === 0) {
    lines.push("No patterns found.");
    lines.push("</PATTERNS>");
    return lines.join("\n");
  }

  for (let i = 0; i < result.patterns.length; i++) {
    const pattern = result.patterns[i];
    const num = String(i + 1).padStart(3, "0");

    lines.push(`[P${num}] ${pattern.name}`);
    lines.push(`  Description: ${pattern.description}`);

    if (pattern.tags && pattern.tags.length > 0) {
      lines.push(`  Tags: ${pattern.tags.join(", ")}`);
    }

    lines.push(`  Used: ${pattern.usage_count} time${pattern.usage_count === 1 ? "" : "s"}`);
    lines.push("");
  }

  lines.push("</PATTERNS>");

  return lines.join("\n");
}

interface PatternShowResult {
  id: string;
  name: string;
  description: string;
  content: string;
  tags?: string[];
  source_session_id?: string;
  source_range?: string;
  usage_count: number;
  created_at: string;
}

export function formatPatternShow(result: PatternShowResult): string {
  const lines: string[] = [];

  lines.push(`<PATTERN name="${result.name}">`);
  lines.push(`# ${result.name}`);
  lines.push("");
  lines.push("## Description");
  lines.push(result.description);
  lines.push("");

  if (result.tags && result.tags.length > 0) {
    lines.push("## Tags");
    lines.push(result.tags.join(", "));
    lines.push("");
  }

  lines.push("## Content");
  lines.push(result.content);
  lines.push("");

  if (result.source_session_id) {
    lines.push("## Source");
    const sessionShort = truncateId(result.source_session_id);
    const rangePart = result.source_range ? ` lines ${result.source_range}` : "";
    lines.push(`Session [${sessionShort}]${rangePart}`);
    lines.push("");
  }

  lines.push(`Used: ${result.usage_count} time${result.usage_count === 1 ? "" : "s"}`);
  lines.push("</PATTERN>");

  return lines.join("\n");
}
