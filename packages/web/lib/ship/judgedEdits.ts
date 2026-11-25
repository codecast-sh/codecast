// The judged files a session edited, for Ship's confirm (ct-100350): a press approves only the judged files listed
// beside the button, so the confirm lists them and the press records exactly that list (convex changeApprovals.ts).
import { mayBeJudged } from "@codecast/convex/convex/lib/judgedDiff";
import { toolRowKind } from "../modernRow";
import { isNoiseUserMessage } from "../conversationProcessor";

type Message = { tool_calls?: ReadonlyArray<{ name?: string; input?: string } | null> | null };

/** Paths the session's edit and write calls touched, relative to its checkout's root, once each, sorted. */
export function editedPaths(messages: ReadonlyArray<Message>, root: string | null): string[] {
  const out = new Set<string>();
  const prefix = root ? (root.endsWith("/") ? root : `${root}/`) : null;
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      const kind = toolRowKind(String(call?.name ?? ""));
      if (kind !== "edit" && kind !== "write") continue;
      let path: unknown;
      try { const input = JSON.parse(call?.input ?? "{}"); path = input.file_path ?? input.notebook_path ?? input.path; } catch { continue; }
      if (typeof path !== "string" || !path) continue;
      if (path.startsWith("/")) {
        if (!prefix || !path.startsWith(prefix)) continue;
        out.add(path.slice(prefix.length));
      } else {
        out.add(path.replace(/^\.\//, ""));
      }
    }
  }
  return [...out].sort();
}

/**
 * The edited paths main's judges file may judge (a `name#key` entry's file is listed by its name, since its content
 * decides only after the change is pushed); null when the repository is not opted in (nothing is listed).
 */
export function judgedEdits(messages: ReadonlyArray<Message>, root: string | null, judges: ReadonlyArray<string> | null | undefined): string[] | null {
  if (!judges) return null;
  return editedPaths(messages, root).filter((p) => mayBeJudged(p, judges));
}

/** A judged file Ship lists, with the sessions that wrote it (ids from judgedList, titles once usePressApproval names them). */
export type JudgedFile = { path: string; writers: string[] };

/**
 * Everything Ship lists for a session's change: the judged files codecast knows the change touches (`change`, convex
 * changeApprovals.shipList: its pull request's judged diff and its checkout's uncommitted judged files, by writer)
 * and this session's own judged edits, written by `self`. Null when the repository is not opted in.
 */
export function judgedList(messages: ReadonlyArray<Message>, root: string | null, self: string, change: { judges: ReadonlyArray<string>; files: ReadonlyArray<JudgedFile> } | null): JudgedFile[] | null {
  if (!change) return null;
  const by = new Map<string, Set<string>>(change.files.map((f) => [f.path, new Set(f.writers)]));
  for (const path of judgedEdits(messages, root, change.judges) ?? []) by.set(path, (by.get(path) ?? new Set()).add(self));
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([path, writers]) => ({ path, writers: [...writers] }));
}

/** A listed file in a line of words: the path, then who wrote it when codecast knows. */
export const judgedFileWords = (f: JudgedFile) => (f.writers.length ? `${f.path} · ${f.writers.join(", ")}` : f.path);

/** Whether a typed line asks for the work to ship: "ship", "ship it", "ship this", "yes, ship it", alone on the line. */
export function saysShip(text: string | null | undefined): boolean {
  return /^\s*(yes[,.!]?\s+)?ship(\s+(it|this|that))?\s*[.!]*\s*$/i.test(String(text ?? ""));
}

/** The newest message a person typed in the thread, when it says ship: its id, else null. A tool's result and a
 *  harness notice ride as user rows too; neither is typed, so the agent's work after "ship" keeps the list up. */
export function typedShip(messages: ReadonlyArray<{ _id?: string; role?: string; content?: string | null; tool_results?: ReadonlyArray<unknown> | null }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || m.tool_results?.length || isNoiseUserMessage(m.content)) continue;
    return saysShip(m.content) && m._id ? String(m._id) : null;
  }
  return null;
}
