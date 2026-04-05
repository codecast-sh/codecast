/**
 * JSONL Round-Trip Fidelity Test
 *
 * Tests that: original JSONL → parse → DB format → generate → parse
 * produces the same message sequence. This isolates the generator's fidelity
 * from DB sync issues (compaction, truncation, etc.).
 *
 * Also tests the full DB round-trip for sessions that have a matching
 * conversation in the DB.
 *
 * Usage: bun tests/jsonl-fidelity/roundtrip.ts [--count 10] [--session <id>]
 */

import * as fs from "fs";
import * as path from "path";
import { decryptToken } from "../../packages/cli/src/tokenEncryption.js";
import { parseSessionFile, extractMessages, parseSessionLine, type ParsedMessage, type ClaudeSessionEntry } from "../../packages/cli/src/parser.js";
import {
  fetchExport,
  generateClaudeCodeJsonl,
  type ExportResult,
  type ExportedMessage,
} from "../../packages/cli/src/jsonlGenerator.js";

// ── Config ──────────────────────────────────────────────────

const CONFIG_PATH = path.join(process.env.HOME!, ".codecast", "config.json");
const CONV_CACHE_PATH = path.join(process.env.HOME!, ".codecast", "conversations.json");
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME!, ".claude", "projects");

interface Config {
  convex_url: string;
  auth_token: string;
  user_id: string;
}

type ConversationCache = Record<string, string>;

function loadConfig(): Config {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw);
}

// ── Find sessions ───────────────────────────────────────────

interface SessionFile {
  sessionId: string;
  filePath: string;
  lineCount: number;
  projectSlug: string;
}

function findLargestSessions(count: number): SessionFile[] {
  const results: SessionFile[] = [];

  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  for (const dir of projectDirs) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, dir);
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
    } catch { continue; }

    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = file.replace(".jsonl", "");
      const content = fs.readFileSync(filePath, "utf8");
      const lineCount = content.split("\n").filter((l) => l.trim()).length;
      results.push({ sessionId, filePath, lineCount, projectSlug: dir });
    }
  }

  return results.sort((a, b) => b.lineCount - a.lineCount).slice(0, count);
}

// ── Convert ParsedMessage to ExportedMessage (simulate DB) ──

function parsedToExported(msgs: ParsedMessage[], projectPath: string): ExportResult {
  const exportedMessages: ExportedMessage[] = [];

  for (const msg of msgs) {
    if (msg.role === "system") continue; // DB filters these via isNonEmptyMessage behavior

    const exported: ExportedMessage = {
      role: msg.role,
      content: msg.content || "",
      timestamp: new Date(msg.timestamp).toISOString(),
      message_uuid: msg.uuid,
      thinking: msg.thinking,
    };

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      exported.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: JSON.stringify(tc.input), // DB stores as string
      }));
    }

    if (msg.toolResults && msg.toolResults.length > 0) {
      exported.tool_results = msg.toolResults.map((tr) => ({
        tool_use_id: tr.toolUseId,
        content: tr.content,
        is_error: tr.isError,
      }));
    }

    exportedMessages.push(exported);
  }

  return {
    conversation: {
      id: "test",
      title: "Test Session",
      session_id: "test-session",
      agent_type: "claude_code",
      project_path: projectPath,
      model: "claude-opus-4-6-20260205",
      message_count: exportedMessages.length,
      started_at: exportedMessages[0]?.timestamp || new Date().toISOString(),
      updated_at: exportedMessages[exportedMessages.length - 1]?.timestamp || new Date().toISOString(),
    },
    messages: exportedMessages,
  };
}

// ── Message comparison ──────────────────────────────────────

interface MessageDiff {
  index: number;
  field: string;
  original: string;
  generated: string;
}

interface ComparisonResult {
  sessionId: string;
  originalCount: number;
  generatedCount: number;
  countMatch: boolean;
  diffs: MessageDiff[];
}

function normalizeContent(s: string | undefined): string {
  return (s || "").trim();
}

function normalizeToolCalls(
  tcs: Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined
): string {
  if (!tcs || tcs.length === 0) return "[]";
  return JSON.stringify(tcs.map((tc) => ({ id: tc.id, name: tc.name, inputKeys: Object.keys(tc.input).sort() })));
}

function normalizeToolResults(
  trs: Array<{ toolUseId: string; content: string; isError?: boolean }> | undefined
): string {
  if (!trs || trs.length === 0) return "[]";
  return JSON.stringify(trs.map((tr) => ({
    toolUseId: tr.toolUseId,
    contentLen: (tr.content || "").length,
    isError: !!tr.isError,
  })));
}

function compareMessages(original: ParsedMessage[], generated: ParsedMessage[]): ComparisonResult {
  const diffs: MessageDiff[] = [];

  for (let i = 0; i < Math.min(original.length, generated.length); i++) {
    const orig = original[i];
    const gen = generated[i];

    if (orig.role !== gen.role) {
      diffs.push({ index: i, field: "role", original: orig.role, generated: gen.role });
    }

    const origContent = normalizeContent(orig.content);
    const genContent = normalizeContent(gen.content);
    if (origContent !== genContent) {
      // Check for truncation
      const isTrunc = genContent.endsWith("... (truncated)") &&
        origContent.startsWith(genContent.replace(/\n?\.\.\. \(truncated\)$/, ""));
      diffs.push({
        index: i,
        field: isTrunc ? "content[truncated]" : "content",
        original: origContent.slice(0, 200) + (origContent.length > 200 ? `... (${origContent.length}c)` : ""),
        generated: genContent.slice(0, 200) + (genContent.length > 200 ? `... (${genContent.length}c)` : ""),
      });
    }

    const origTc = normalizeToolCalls(orig.toolCalls);
    const genTc = normalizeToolCalls(gen.toolCalls);
    if (origTc !== genTc) {
      diffs.push({ index: i, field: "toolCalls", original: origTc.slice(0, 300), generated: genTc.slice(0, 300) });
    }

    const origTr = normalizeToolResults(orig.toolResults);
    const genTr = normalizeToolResults(gen.toolResults);
    if (origTr !== genTr) {
      diffs.push({ index: i, field: "toolResults", original: origTr.slice(0, 300), generated: genTr.slice(0, 300) });
    }

    // Compare thinking presence
    const origHasThinking = !!(orig.thinking && orig.thinking.trim());
    const genHasThinking = !!(gen.thinking && gen.thinking.trim());
    if (origHasThinking !== genHasThinking) {
      diffs.push({
        index: i, field: "thinking",
        original: origHasThinking ? `yes (${orig.thinking!.length}c)` : "no",
        generated: genHasThinking ? `yes (${gen.thinking!.length}c)` : "no",
      });
    }
  }

  return {
    sessionId: "",
    originalCount: original.length,
    generatedCount: generated.length,
    countMatch: original.length === generated.length,
    diffs,
  };
}

// ── Detailed diff for first few mismatches ──────────────────

function printDetailedDiff(original: ParsedMessage[], generated: ParsedMessage[], maxMsgs: number = 20) {
  const minLen = Math.min(original.length, generated.length, maxMsgs);

  // Find first divergence point
  let divergeAt = -1;
  for (let i = 0; i < minLen; i++) {
    if (original[i].role !== generated[i].role ||
        normalizeContent(original[i].content) !== normalizeContent(generated[i].content)) {
      divergeAt = i;
      break;
    }
  }

  if (divergeAt === -1 && original.length === generated.length) {
    return; // No structural divergence
  }

  const start = Math.max(0, divergeAt - 1);
  const end = Math.min(minLen, divergeAt + 6);

  console.log(`\n   Divergence at message ${divergeAt}:`);
  for (let i = start; i < end; i++) {
    const o = original[i];
    const g = generated[i];
    const roleMatch = o.role === g.role;
    const marker = roleMatch ? "  " : ">>"; // highlight mismatches

    const oToolInfo = [
      o.toolCalls?.length ? `tc:${o.toolCalls.length}` : "",
      o.toolResults?.length ? `tr:${o.toolResults.length}` : "",
    ].filter(Boolean).join(",");

    const gToolInfo = [
      g.toolCalls?.length ? `tc:${g.toolCalls.length}` : "",
      g.toolResults?.length ? `tr:${g.toolResults.length}` : "",
    ].filter(Boolean).join(",");

    const oContent = (o.content || "").slice(0, 60).replace(/\n/g, "\\n");
    const gContent = (g.content || "").slice(0, 60).replace(/\n/g, "\\n");

    console.log(`   ${marker} [${i}] orig: ${o.role.padEnd(10)} ${oToolInfo.padEnd(8)} "${oContent}"`);
    console.log(`   ${marker} [${i}]  gen: ${g.role.padEnd(10)} ${gToolInfo.padEnd(8)} "${gContent}"`);
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let count = 10;
  let targetSession: string | null = null;
  let verbose = args.includes("--verbose") || args.includes("-v");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--count" && args[i + 1]) count = parseInt(args[i + 1]);
    if (args[i] === "--session" && args[i + 1]) targetSession = args[i + 1];
  }

  let sessions: SessionFile[];
  if (targetSession) {
    const all = findLargestSessions(99999);
    sessions = all.filter((s) => s.sessionId.startsWith(targetSession!));
    if (sessions.length === 0) {
      console.error(`Session ${targetSession} not found`);
      process.exit(1);
    }
  } else {
    sessions = findLargestSessions(count);
  }

  console.log(`\n Testing ${sessions.length} sessions: parse -> DB format -> generate -> parse\n`);
  console.log("-".repeat(80));

  const allResults: ComparisonResult[] = [];

  for (const session of sessions) {
    const projectPath = session.projectSlug.replace(/-/g, "/").replace(/^\//, "/");
    console.log(`\n ${session.sessionId.slice(0, 8)}... (${session.lineCount} lines)`);

    try {
      // 1. Parse original JSONL
      const originalContent = fs.readFileSync(session.filePath, "utf8");
      const originalMessages = parseSessionFile(originalContent);

      // Filter to match what the DB export would return:
      // - No system messages (stored differently)
      // - No image-only messages (ExportedMessage format doesn't include images,
      //   and isNonEmptyMessage filters out messages with no content/tools)
      const origFiltered = originalMessages.filter((m) => {
        if (m.role === "system") return false;
        // Match isNonEmptyMessage: must have content, toolCalls, or toolResults
        const hasContent = m.content && m.content.trim();
        const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
        const hasToolResults = m.toolResults && m.toolResults.length > 0;
        return !!(hasContent || hasToolCalls || hasToolResults);
      });
      const filtered = originalMessages.length - origFiltered.length;
      console.log(`   Original: ${origFiltered.length} messages (${filtered} filtered)`);

      // 2. Convert to DB format (ExportedMessages)
      const exportData = parsedToExported(origFiltered, projectPath);

      // 3. Generate JSONL from DB format
      const { jsonl: generatedJsonl } = generateClaudeCodeJsonl(exportData, {
        sessionId: session.sessionId,
      });

      // 4. Parse generated JSONL
      const generatedMessages = parseSessionFile(generatedJsonl).filter((m) => m.role !== "system");
      console.log(`   Generated: ${generatedMessages.length} messages`);

      // 5. Compare
      const result = compareMessages(origFiltered, generatedMessages);
      result.sessionId = session.sessionId;
      allResults.push(result);

      if (result.countMatch && result.diffs.length === 0) {
        console.log(`   MATCH`);
      } else {
        if (!result.countMatch) {
          console.log(`   Count: ${result.originalCount} vs ${result.generatedCount} (${result.generatedCount > result.originalCount ? "+" : ""}${result.generatedCount - result.originalCount})`);
        }
        if (result.diffs.length > 0) {
          // Group diffs by field
          const byField = new Map<string, number>();
          for (const d of result.diffs) {
            byField.set(d.field, (byField.get(d.field) || 0) + 1);
          }
          console.log(`   ${result.diffs.length} diffs: ${[...byField.entries()].map(([f, c]) => `${f}:${c}`).join(", ")}`);

          if (verbose) {
            for (const d of result.diffs.slice(0, 5)) {
              console.log(`      [${d.index}] ${d.field}: "${d.original.slice(0,80)}" vs "${d.generated.slice(0,80)}"`);
            }
            // Show first diff message details
            const firstDiffIdx = result.diffs[0]?.index;
            if (firstDiffIdx !== undefined) {
              const start = Math.max(0, firstDiffIdx - 1);
              const end = Math.min(origFiltered.length, firstDiffIdx + 3);
              console.log(`\n   Detail around msg ${firstDiffIdx}:`);
              for (let i = start; i < end; i++) {
                const o = origFiltered[i];
                const g = generatedMessages[i];
                console.log(`   [${i}] ORIG: role=${o?.role} content=${JSON.stringify((o?.content||"").slice(0,80))} tc=${o?.toolCalls?.length||0} tr=${o?.toolResults?.length||0} think=${!!(o?.thinking)} img=${!!(o?.images?.length)}`);
                if (g) console.log(`   [${i}]  GEN: role=${g.role} content=${JSON.stringify((g.content||"").slice(0,80))} tc=${g.toolCalls?.length||0} tr=${g.toolResults?.length||0}`);
              }
            }
          }
        }

        // Show structural divergence
        printDetailedDiff(origFiltered, generatedMessages);
      }
    } catch (err) {
      console.log(`   Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const perfect = allResults.filter((r) => r.countMatch && r.diffs.length === 0);
  const imperfect = allResults.filter((r) => !r.countMatch || r.diffs.length > 0);

  console.log(`Total:    ${allResults.length}`);
  console.log(`Perfect:  ${perfect.length}`);
  console.log(`Diffs:    ${imperfect.length}`);

  // Aggregate diff types
  const allDiffFields = new Map<string, number>();
  let totalDiffs = 0;
  for (const r of allResults) {
    for (const d of r.diffs) {
      allDiffFields.set(d.field, (allDiffFields.get(d.field) || 0) + 1);
      totalDiffs++;
    }
  }
  if (allDiffFields.size > 0) {
    console.log(`\nDiff breakdown (${totalDiffs} total):`);
    for (const [field, count] of [...allDiffFields.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field}: ${count}`);
    }
  }

  console.log();
  process.exit(imperfect.length > 0 ? 1 : 0);
}

main().catch(console.error);
