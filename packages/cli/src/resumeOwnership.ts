/**
 * `cast resume` runs the agent in the foreground on THIS machine, so the
 * conversation must be owned by this machine too. The server routes every
 * message and restart sent from the web to `owner_device_id`, and the daemon on
 * any other machine refuses to deliver (the single-owner guard). A resume that
 * left ownership behind kept the old machine as the delivery target: once it
 * slept, messages from the web waited on a daemon that was gone while the
 * session ran fine here, and the old machine's copy kept answering in parallel
 * when it woke.
 *
 * Adopting goes through moveSessionToDevice with resume:false, the same flip a
 * web move makes minus the daemon resume (this process is the resume): it
 * restamps the owner, writes the machine-switch divider, and tells the old
 * machine to release its copy.
 */

import { serverErrorLine } from "./serverError.js";
import * as fs from "node:fs";
import { deviceId } from "./remote/device.js";

export interface ResumeOwnershipDeps {
  thisDeviceId: string;
  /** The conversation's current owner device, or null when it has none. Throws on a failed lookup. */
  getOwnerDeviceId: () => Promise<string | null>;
  /** Make this machine the owner and release the previous one. */
  moveHere: (projectPath: string) => Promise<unknown>;
}

export type ResumeOwnershipResult =
  | { kind: "already_here" }
  | { kind: "adopted"; from: string | null }
  | { kind: "failed"; error: string };

export async function adoptConversationForResume(
  deps: ResumeOwnershipDeps,
  projectPath: string,
): Promise<ResumeOwnershipResult> {
  let owner: string | null;
  try {
    owner = await deps.getOwnerDeviceId();
  } catch (err) {
    return { kind: "failed", error: errorText(err) };
  }
  if (owner === deps.thisDeviceId) return { kind: "already_here" };
  try {
    await deps.moveHere(projectPath);
  } catch (err) {
    return { kind: "failed", error: errorText(err) };
  }
  return { kind: "adopted", from: owner };
}

/** The line `cast resume` prints for a result, or null when there is nothing to say. */
export function describeResumeOwnership(result: ResumeOwnershipResult, sessionRef: string): string | null {
  switch (result.kind) {
    case "already_here":
      return null;
    case "adopted":
      return result.from
        ? "Moved this session to this machine: messages sent from codecast now come here, and the other machine stops its copy."
        : null;
    case "failed":
      return `Couldn't move this session to this machine (${result.error}). Messages sent from codecast may still go to the machine it ran on before; run \`cast pull ${sessionRef}\` to move it here.`;
  }
}

function errorText(err: unknown): string {
  return serverErrorLine(err instanceof Error ? err.message : String(err));
}

/** Adopt the conversation for a foreground launch about to run in `projectPath`
 *  (or this directory, when that path is not on this machine), and say what happened. */
export async function adoptForForegroundResume(conversationId: string, projectPath?: string | null): Promise<void> {
  const cwd = projectPath && fs.existsSync(projectPath) ? projectPath : process.cwd();
  let result: ResumeOwnershipResult;
  try {
    const { convexClient } = await import("./remote/convexClient.js");
    const { client, token, api } = await convexClient({ timeoutMs: 10_000 });
    result = await adoptConversationForResume({
      thisDeviceId: deviceId(),
      getOwnerDeviceId: async () => {
        const info = await client.query(api.devices.getConversationOwner, { api_token: token, conversation_id: conversationId });
        if (!info) throw new Error("conversation not found");
        return info.owner_device_id ?? null;
      },
      moveHere: (path) => client.mutation(api.devices.moveSessionToDevice, {
        api_token: token,
        conversation_id: conversationId,
        owner_device_id: deviceId(),
        project_path: path,
        resume: false,
      }),
    }, cwd);
  } catch (err) {
    result = { kind: "failed", error: errorText(err) };
  }
  const line = describeResumeOwnership(result, conversationId);
  if (line) console.log(result.kind === "failed" ? `! ${line}` : line);
}
