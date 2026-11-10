import { useMemo, useRef, useState } from "react";
import { inferHomeDir } from "../lib/utils";
import { namedAbsolutePaths } from "../lib/filePathLinks";
import { typedPollAnswerTexts } from "../lib/pollPayload";
import type { SentFileData } from "../components/tools/SentFileBlock";
import type { ImageData, Message, ToolResult } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";
import { ToolCallMemo, keepIfSameRecord, sameElements } from "./toolCallMemo";

// Every tool result by its call id, with the typed answer of a declined poll.
export function toolResultMapOf(messages: readonly Message[]): Record<string, ToolResult> {
  const map: Record<string, ToolResult> = {};
  for (const msg of messages) {
    if (msg.tool_results) {
      for (const tr of msg.tool_results) {
        map[tr.tool_use_id] = tr;
      }
    }
  }
  for (const [id, typed_answer] of Object.entries(typedPollAnswerTexts(messages))) {
    if (map[id]) map[id] = { ...map[id], typed_answer };
  }
  return map;
}

// A result carrying a typed answer is a fresh copy on every pass; it is the
// same result when every field is.
function sameToolResult(a: ToolResult, b: ToolResult): boolean {
  if (a === b) return true;
  if (a.typed_answer === undefined || b.typed_answer === undefined) return false;
  const keys = Object.keys(a) as Array<keyof ToolResult>;
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(a[k], b[k]));
}

/**
 * The absolute paths the transcript's tool calls name, sorted, one per line:
 * namedAbsolutePaths over every call input, with each call's paths memoized
 * so a streamed update parses only the calls it added or changed.
 */
export function knownPathsKeyOf(messages: readonly Message[], home: string | undefined, memo: ToolCallMemo<string[]>): string {
  memo.begin(home);
  const out = new Set<string>();
  for (const msg of messages) {
    for (const tc of msg.tool_calls ?? []) {
      for (const p of memo.get(tc, (call) => namedAbsolutePaths([call.input], home))) out.add(p);
    }
  }
  memo.end();
  return [...out].sort().join("\n");
}

export function useToolResultMaps({ conversation, codeRepository, pullRequestIds }: {
  conversation: ConversationData | null | undefined;
  codeRepository: string | null;
  pullRequestIds?: ReadonlySet<string>;
}) {
  // Each map keeps its identity across a pass that changed nothing in it: every
  // AssistantBlock takes the image and file maps (and, condensed, the result
  // map) as props, so a fresh map per streamed update re-rendered them all.
  const toolResultMapRef = useRef<Record<string, ToolResult> | undefined>(undefined);
  const globalToolResultMap = useMemo(() => {
    const next = keepIfSameRecord(toolResultMapRef.current, toolResultMapOf(conversation?.messages ?? []), sameToolResult);
    toolResultMapRef.current = next;
    return next;
  }, [conversation?.messages]);

  // Tool images live on the tool_result message, not the assistant message
  // that made the call, so the ToolBlock finds them by tool id here. A list,
  // not a single image: one command can hand back several (`cast browser
  // shot --viewports`), and keeping only the last would silently drop the rest.
  // Sent files (SendUserFile) ride the same index, for the same reason: a
  // condensed row renders tool blocks from OTHER messages, so binding by tool
  // id is what keeps a folded delivery attached to its own card.
  const mediaMapsRef = useRef<{ globalImageMap: Record<string, ImageData[]>; globalFileMap: Record<string, SentFileData[]> } | undefined>(undefined);
  const { globalImageMap, globalFileMap } = useMemo(() => {
    const map: Record<string, ImageData[]> = {};
    const fileMap: Record<string, SentFileData[]> = {};
    for (const msg of conversation?.messages ?? []) {
      if (msg.images) {
        for (const img of msg.images) {
          if (img.tool_use_id) {
            (map[img.tool_use_id] ??= []).push(img);
          }
        }
      }
      if (msg.files) {
        for (const file of msg.files) {
          if (file.tool_use_id) {
            (fileMap[file.tool_use_id] ??= []).push(file);
          }
        }
      }
    }
    const prev = mediaMapsRef.current;
    const next = {
      globalImageMap: keepIfSameRecord(prev?.globalImageMap, map, sameElements),
      globalFileMap: keepIfSameRecord(prev?.globalFileMap, fileMap, sameElements),
    };
    mediaMapsRef.current = next;
    return next;
  }, [conversation?.messages]);

  // toolCallId → page URL + tab id for every `cast browser` row, carrying the
  // last known ones across rows whose output doesn't restate them. Identity is
  // kept stable across recomputes with identical content (the common case: a
  // message sync that added no browser rows), so the CastBrowserRowContext
  // consumers — every cast row — don't re-render on unrelated syncs.
  // Where relative file mentions in this conversation resolve (FilePathLink):
  // the session's working directory, and the home it implies for `~/…`.
  // knownPaths are the absolute paths its tool calls named, which place a
  // mention written relative to somewhere else. Keyed by content so a message
  // sync that named no new path keeps every link's context stable.
  const filePathBase = conversation?.project_path || conversation?.git_root || undefined;
  const gitRoot = conversation?.git_root || null;
  const home = inferHomeDir([filePathBase]);
  const [knownPathsMemo] = useState(() => new ToolCallMemo<string[]>());
  const knownPathsKey = useMemo(
    () => knownPathsKeyOf(conversation?.messages ?? [], home, knownPathsMemo),
    [conversation?.messages, home, knownPathsMemo],
  );
  const filePathCtx = useMemo(
    () => ({
      base: filePathBase,
      home,
      repository: codeRepository,
      pullRequestIds,
      gitRoot,
      knownPaths: knownPathsKey ? knownPathsKey.split("\n") : [],
    }),
    [filePathBase, home, codeRepository, pullRequestIds, gitRoot, knownPathsKey],
  );

  return { globalToolResultMap, globalImageMap, globalFileMap, filePathBase, filePathCtx };
}
