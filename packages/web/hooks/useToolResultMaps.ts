import { useMemo } from "react";
import { inferHomeDir } from "../lib/utils";
import type { SentFileData } from "../components/tools/SentFileBlock";
import type { ImageData, Message, ToolResult } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";

export function useToolResultMaps({ conversation, codeRepository }: {
  conversation: ConversationData | null | undefined;
  codeRepository: string | null;
}) {
  const toolCallMap = useMemo(() => {
    const map: Record<string, string> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            map[tc.id] = tc.name;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  const globalToolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_results) {
          for (const tr of msg.tool_results) {
            map[tr.tool_use_id] = tr;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  // Tool images live on the tool_result message, not the assistant message
  // that made the call, so the ToolBlock finds them by tool id here. A list,
  // not a single image: one command can hand back several (`cast browser
  // shot --viewports`), and keeping only the last would silently drop the rest.
  // Sent files (SendUserFile) ride the same index, for the same reason: a
  // condensed row renders tool blocks from OTHER messages, so binding by tool
  // id is what keeps a folded delivery attached to its own card.
  const { globalImageMap, globalFileMap } = useMemo(() => {
    const map: Record<string, ImageData[]> = {};
    const fileMap: Record<string, SentFileData[]> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
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
    }
    return { globalImageMap: map, globalFileMap: fileMap };
  }, [conversation?.messages]);

  // toolCallId → page URL + tab id for every `cast browser` row, carrying the
  // last known ones across rows whose output doesn't restate them. Identity is
  // kept stable across recomputes with identical content (the common case: a
  // message sync that added no browser rows), so the CastBrowserRowContext
  // consumers — every cast row — don't re-render on unrelated syncs.
  // Where relative file mentions in this conversation resolve (FilePathLink):
  // the session's working directory, and the home it implies for `~/…`.
  const filePathBase = conversation?.project_path || conversation?.git_root || undefined;
  const filePathCtx = useMemo(() => ({ base: filePathBase, home: inferHomeDir([filePathBase]), repository: codeRepository }), [filePathBase, codeRepository]);

  return { globalToolResultMap, globalImageMap, globalFileMap, filePathBase, filePathCtx };
}
