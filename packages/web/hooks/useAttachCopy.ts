import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { copyToClipboard } from "../lib/utils";
import { attachCopy, type SessionMachine } from "../components/tmuxAttach";

/**
 * The machine a pane lives on, and the copy gesture for it. One hook so every
 * surface that offers "copy the attach command" — the header pill and the
 * simple-view menu — copies the same command and explains it the same way.
 */
export function useAttachCopy(tmuxSession: string | null | undefined, conversationKey: string | undefined) {
  // useQueryNoThrow, not useQuery: this lookup only ENRICHES the pill (it names
  // the machine and shapes the copy command). Without it the pill still renders
  // something honest. A plain useQuery re-throws during render, and this exact
  // query taking the whole conversation header down is why the rule exists.
  const machine = useQueryNoThrow(
    api.devices.getConversationMachine,
    tmuxSession && conversationKey ? { conversation_id: conversationKey as any } : "skip",
  ).data as SessionMachine | null | undefined;
  const copy = tmuxSession ? attachCopy(tmuxSession, machine) : null;
  const command = copy?.command ?? null;
  const message = copy?.message ?? "";
  const copyAttach = useCallback(() => {
    if (!message) return;
    // Nothing to copy is still an answer: say where the pane is and how to
    // bring it here, rather than swallowing the click.
    if (!command) {
      toast.info(message);
      return;
    }
    copyToClipboard(command)
      .then(() => toast.success(message))
      .catch(() => toast.error("Failed to copy"));
  }, [command, message]);
  return { machine, attach: command, copyAttach };
}
