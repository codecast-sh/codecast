import { getApplyPatchInput, parseApplyPatchSections } from "./applyPatchParser";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "./unifiedDiffParser";
import { embeddedApplyPatches, shellApplyPatches } from "./embeddedPatch";

export interface FileChange {
  id: string;
  toolCallId?: string;
  sequenceIndex: number;
  messageId: string;
  filePath: string;
  changeType: "write" | "edit" | "commit";
  oldContent?: string;
  newContent: string;
  commitMessage?: string;
  commitHash?: string;
  timestamp: number;
}

/**
 * Minimal structural shape the extractor needs from a message. Both a full
 * Convex `Doc<"messages">` and the redacted fields built inside the message
 * ingest mutations are assignable to this, so the same extraction runs on the
 * web client and inside a server mutation with no type coupling either way.
 */
export interface ExtractableMessage {
  _id: string;
  timestamp: number;
  tool_calls?: Array<{ id: string; name: string; input: string }> | null;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }> | null;
}

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "shell_command", "exec_command", "commandexecution", "run_shell_command"]);
const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "file_edit",
  "edit_file",
  "replace",
  "str_replace",
  "file_write",
  "write_file",
  "create_file",
  "apply_patch",
  "exec",
  "filechange",
  ...SHELL_TOOL_NAMES,
]);

function toolName(name: string): string {
  return name.split(".").at(-1)!.toLowerCase();
}

/** Cheap pre-filter: does this message carry any tool call that could produce a file change? */
export function hasFileChangeToolCall(message: ExtractableMessage): boolean {
  return !!message.tool_calls?.some((tc) => EDIT_TOOL_NAMES.has(toolName(tc.name)));
}

export function extractFileChanges(messages: ExtractableMessage[]): FileChange[] {
  const changes: FileChange[] = [];
  let sequenceIndex = 0;

  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const results = new Map(sortedMessages.flatMap((message) =>
    (message.tool_results ?? []).map((result) => [result.tool_use_id, result] as const),
  ));

  for (const message of sortedMessages) {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      const name = toolName(toolCall.name);
      const result = results.get(toolCall.id);
      if (!EDIT_TOOL_NAMES.has(name) || (result?.is_error && !SHELL_TOOL_NAMES.has(name))) {
        continue;
      }

      if (name === "apply_patch" || name === "exec" || SHELL_TOOL_NAMES.has(name)) {
        let patchInputs: string[] = [];
        if (name === "apply_patch") patchInputs = [getApplyPatchInput(toolCall.input)];
        else {
          try {
            const params = JSON.parse(toolCall.input);
            const source = typeof params === "string" ? params : params?.input ?? params?.command ?? params?.cmd;
            if (typeof source === "string") patchInputs = name === "exec" ? embeddedApplyPatches(source) : shellApplyPatches(source);
          } catch {
            if (name === "exec") patchInputs = embeddedApplyPatches(toolCall.input);
          }
        }

        const sections = result?.is_error ? [] : patchInputs.flatMap(parseApplyPatchSections);

        sections.forEach((section, sectionIndex) => {
          const isAdd = section.operation === "Add";
          changes.push({
            id: `${toolCall.id}:${sectionIndex}`,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: section.filePath,
            changeType: isAdd ? "write" : "edit",
            oldContent: section.oldContent || undefined,
            newContent: section.newContent,
            timestamp: message.timestamp,
          });
        });
        if (!SHELL_TOOL_NAMES.has(name)) continue;
      }

      if (name === "filechange") {
        let summary = "";
        try {
          const params = JSON.parse(toolCall.input);
          summary = typeof params?.changes === "string" ? params.changes : "";
        } catch {
          continue;
        }

        const sections = parseUnifiedDiffSections(result?.content || "", parseFileChangeSummary(summary));
        if (sections.length === 0) {
          continue;
        }

        sections.forEach((section, sectionIndex) => {
          changes.push({
            id: `${toolCall.id}:${sectionIndex}`,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: section.filePath,
            changeType: section.oldContent ? "edit" : "write",
            oldContent: section.oldContent || undefined,
            newContent: section.newContent,
            timestamp: message.timestamp,
          });
        });
        continue;
      }

      try {
        const params = JSON.parse(toolCall.input);
        if (!params || typeof params !== "object") continue;
        const filePath = params.file_path ?? params.filePath ?? params.path;

        if (["edit", "file_edit", "edit_file", "replace", "str_replace", "multiedit"].includes(name)) {
          if (typeof filePath !== "string" || !filePath) {
            continue;
          }
          const edits = name === "multiedit" ? params.edits : [params];
          if (!Array.isArray(edits)) continue;
          for (const [index, edit] of edits.entries()) {
            if (!edit || typeof edit !== "object") continue;
            const oldContent = edit.old_string ?? edit.oldString ?? edit.oldText;
            const newContent = edit.new_string ?? edit.newString ?? edit.newText;
            if (typeof oldContent !== "string" || typeof newContent !== "string") continue;
            changes.push({
              id: name === "multiedit" ? `${toolCall.id}:${index}` : toolCall.id,
              toolCallId: toolCall.id,
              sequenceIndex: sequenceIndex++,
              messageId: message._id,
              filePath,
              changeType: "edit",
              oldContent,
              newContent,
              timestamp: message.timestamp,
            });
          }
        } else if (["write", "file_write", "write_file", "create_file"].includes(name)) {
          if (typeof filePath !== "string" || !filePath || typeof params.content !== "string") {
            continue;
          }

          changes.push({
            id: toolCall.id,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath,
            changeType: "write",
            newContent: params.content,
            timestamp: message.timestamp,
          });
        } else {
          const command = params.command ?? params.cmd;
          if (typeof command !== "string") continue;
          if (!command || !command.includes("git commit")) {
            continue;
          }

          const commitMessage = extractCommitMessage(command);
          if (!commitMessage) {
            continue;
          }

          const commitHash = result && !result.is_error ? extractCommitHashFromContent(result.content) : undefined;

          changes.push({
            id: toolCall.id,
            toolCallId: toolCall.id,
            sequenceIndex: sequenceIndex++,
            messageId: message._id,
            filePath: "git commit",
            changeType: "commit",
            newContent: commitMessage,
            commitMessage,
            commitHash,
            timestamp: message.timestamp,
          });
        }
      } catch (error) {
        continue;
      }
    }
  }

  return changes;
}

/**
 * Merge server-materialized changes with client-extracted changes (from the
 * paginated message window). Server changes are authoritative and complete for
 * materialized conversations; the client set backfills conversations whose
 * edits predate materialization. Dedupe by the stable change id, order by
 * (timestamp, in-message sequence), then renumber sequenceIndex to the merged
 * position so cumulative-diff ordering stays correct across both sources.
 */
export function mergeFileChanges(
  serverChanges: FileChange[],
  clientChanges: FileChange[],
): FileChange[] {
  const byId = new Map<string, FileChange>();
  // Client first so server wins on conflict — except a git-commit hash, which
  // is parsed from the tool result and may land on a later message patch after
  // the row was already materialized hash-less; keep the client's if present.
  for (const c of clientChanges) byId.set(c.id, c);
  for (const c of serverChanges) {
    const prev = byId.get(c.id);
    byId.set(c.id, prev && !c.commitHash && prev.commitHash ? { ...c, commitHash: prev.commitHash } : c);
  }

  const merged = Array.from(byId.values()).sort(
    (a, b) => a.timestamp - b.timestamp || a.sequenceIndex - b.sequenceIndex,
  );

  return merged.map((c, i) => (c.sequenceIndex === i ? c : { ...c, sequenceIndex: i }));
}

function extractCommitMessage(command: string): string | undefined {
  // Heredoc form first: `git commit -m "$(cat <<'EOF' … EOF)"` (what /commit and
  // most agents emit). It must win over the -m regex below — the heredoc body
  // contains quotes (e.g. `<<'EOF'`), so a naive `-m "…"` match stops at the
  // first inner quote and captures the literal `$(cat <<` instead of the message.
  const heredocMatch = command.match(/<<-?\s*'?(?:EOF|MSG|COMMIT_MSG)'?\s*\n([\s\S]+?)\n\s*(?:EOF|MSG|COMMIT_MSG)\b/);
  if (heredocMatch) {
    return heredocMatch[1].trim();
  }

  // Plain `-m "msg"` / `-m 'msg'`. Anchor the close to the same quote that
  // opened it so an apostrophe inside a double-quoted message doesn't truncate.
  const messageFlagMatch = command.match(/-m\s+"([^"]+)"|-m\s+'([^']+)'/);
  if (messageFlagMatch) {
    return messageFlagMatch[1] ?? messageFlagMatch[2];
  }

  return undefined;
}

/**
 * Parse the short hash out of `git commit` output. Exported because the hash
 * usually can't be extracted at materialization time: the Bash RESULT lands on
 * the next (user) message, after the commit row was inserted hash-less — the
 * ingest path runs this against late-arriving tool_results to patch it in.
 */
export function extractCommitHashFromContent(content: string): string | undefined {
  // git commit prints `[<branch> <short-hash>] <subject>` (with an optional
  // `(root-commit)` marker), so the hash is the last hex token before the `]`,
  // preceded by the `[` itself, whitespace, or the marker's closing paren.
  const hashMatch = content.match(/\[(?:[^\]\n]*[\s()])?([a-f0-9]{7,40})\]/);
  return hashMatch ? hashMatch[1] : undefined;
}
