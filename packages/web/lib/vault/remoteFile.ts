// Reading one file from the machine a conversation ran on, when the machine
// this browser is on lacks it (convex/remoteFiles.ts, cli/src/remoteFileRead.ts).
// Read-only and one file at a time: a link out of a conversation, not a vault.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { ReadFileResult } from "@codecast/shared/contracts";

export type RemoteFileState =
  | { status: "loading"; abs: string; machine: string | null }
  | { status: "ready"; abs: string; machine: string; content: string; size: number; truncated: boolean }
  | { status: "failed"; abs: string; machine: string | null; message: string };

const POLL_MS = 400;
const ANSWER_TIMEOUT_MS = 15_000;

type CommandRow = { executed_at?: number; result?: string; error?: string } | null;

/** What the person reads when the machine answered with an error. */
export function readFailureMessage(error: string, machine: string, abs: string): string {
  if (/unknown command/i.test(error)) return `Update Codecast on ${machine} to open its files from here.`;
  if (/not allowed/i.test(error)) return `${machine} doesn't share ${abs}: it is outside its projects, or it holds keys or credentials.`;
  if (/binary/i.test(error)) return `${abs} on ${machine} is not a text file.`;
  if (/not a file/i.test(error)) return `${abs} on ${machine} is a folder.`;
  return `${machine} couldn't read ${abs}: ${error}`;
}

/** The final state for a command row the machine answered. */
export function stateFromAnswer(row: NonNullable<CommandRow>, abs: string, machine: string): RemoteFileState {
  if (row.error) return { status: "failed", abs, machine, message: readFailureMessage(row.error, machine, abs) };
  let parsed: ReadFileResult | null = null;
  try {
    parsed = row.result ? (JSON.parse(row.result) as ReadFileResult) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { status: "failed", abs, machine, message: `${machine} sent an answer this page can't read.` };
  if (!parsed.exists) return { status: "failed", abs, machine, message: `${abs} does not exist on ${machine}.` };
  return {
    status: "ready",
    abs,
    machine,
    content: parsed.content ?? "",
    size: parsed.size ?? 0,
    truncated: !!parsed.truncated,
  };
}

export async function readRemoteFile(
  convex: ConvexReactClient,
  conversationId: string,
  abs: string,
  isCancelled: () => boolean,
): Promise<RemoteFileState> {
  const req = await convex.mutation(api.remoteFiles.request, {
    conversation_id: conversationId as Id<"conversations">,
    path: abs,
  });
  if (!req.ok) {
    const message =
      req.reason === "not_yours"
        ? `${abs} is on ${req.machine}, which only its owner can read.`
        : req.reason === "no_machine"
          ? `${abs} does not exist on this machine, and the session's machine is unknown.`
          : `${abs} is not a full path.`;
    return { status: "failed", abs, machine: req.machine, message };
  }
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (isCancelled()) return { status: "loading", abs, machine: req.machine };
    const row = (await convex.query(api.users.getCommandResult, { command_id: req.command_id })) as CommandRow;
    if (row?.executed_at) return stateFromAnswer(row, abs, req.machine);
  }
  return { status: "failed", abs, machine: req.machine, message: `${req.machine} didn't answer. It may be asleep or offline.` };
}
