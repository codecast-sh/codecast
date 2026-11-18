import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { copyText } from "../lib/copyText";
import { attachCopy, tailnetSshHost, type SessionMachine } from "../components/tmuxAttach";
import { useInboxStore } from "../store/inboxStore";
import { localDeviceIdOf } from "./useLocalDeviceId";
import type { Device } from "../components/DeviceBadge";

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
  // The pane on this window's own machine attaches locally, even when that
  // machine has an ssh host set for reaching it from elsewhere. Another of
  // yours on a tailnet is reached by its MagicDNS name, but only once this
  // window knows its own machine: until then the pane may be right here.
  const localId = useInboxStore(localDeviceIdOf);
  const isHere = !!machine && machine.device_id === localId;
  const tailnetName = useInboxStore((s) => {
    if (!machine?.is_mine || !localId || isHere) return null;
    const roster = s.machineRoster as Device[];
    const name = roster.find((d) => d.device_id === machine.device_id)?.tailnet?.name;
    return tailnetSshHost(name, roster.find((d) => d.device_id === localId)?.tailnet?.tailnet);
  });
  const copy = tmuxSession ? attachCopy(tmuxSession, machine && { ...machine, tailnet_name: tailnetName, is_here: isHere }) : null;
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
    void copyText(command, message);
  }, [command, message]);
  return { machine, attach: command, copyAttach };
}
