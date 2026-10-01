// The cloud agent behind a conversation and the owner's actions on it, as one
// hook every surface shares (the header chip, the session menu, the command
// palette). The menus that render them are in ./index.tsx.
import type { ComponentType } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Download, GitPullRequest } from "lucide-react";
import { CLOUD_AGENT_ACTIONS, cloudAgentCardKind, cloudAgentLaunch, cloudAgentProblemKind, cloudAgentProviderOfConversation, isCloudAgentId, type CloudAgentActionName, type CloudAgentLaunch, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { useLiveSessionMeta } from "../../hooks/useLiveSessionMeta";
import { useCloudAgentAction } from "../../lib/useProviderKeyCommand";
import { machineName, useCloudAgentStatus } from "./machine";

/**
 * The cloud agent a conversation runs as, or null for a local session: its
 * provider, the agent's id (null until the first message creates it, while
 * the session id is still a local one), what its launch asked for (the model
 * stamp; a task mirrored from the provider's site has none) and whether it is
 * archived there.
 */
export function useCloudAgentOfConversation(conversationId: string | undefined): { spec: CloudAgentProviderSpec; agentId: string | null; launch: CloudAgentLaunch | null; archived: boolean } | null {
  const live = useLiveSessionMeta(conversationId);
  const spec = cloudAgentProviderOfConversation(live?.agentType, live?.sessionId, live?.model);
  if (!spec) return null;
  const agentId = live?.sessionId && isCloudAgentId(spec, live.sessionId) ? live.sessionId : null;
  return { spec, agentId, launch: cloudAgentLaunch(live?.agentType, live?.model), archived: !!live?.cloudAgentArchived };
}

/**
 * The daemon's card a message in a cloud agent session is, or null: the
 * session's provider (from the conversation, never the card's wording), the
 * card's kind, and whether it still holds anything back. A credential card
 * stops holding once the machine that runs the session has the credential,
 * though the card stays in the thread. A limit card counts down the reset
 * the machine reports while it still reports the limit.
 */
export function useCloudAgentSetupCard(conversationId: string | undefined, message: string) {
  const spec = useCloudAgentOfConversation(conversationId)?.spec;
  const status = useCloudAgentStatus(spec, useLiveSessionMeta(conversationId)?.ownerDeviceId);
  const kind = spec ? cloudAgentCardKind(spec, message) : null;
  if (!spec || !kind) return null;
  // A setup card's own kind (the provider changed, a limit, any other setup) is in its sentence.
  const problem = kind === "setup" ? cloudAgentProblemKind(spec, message) : null;
  const resetsAt = problem === "limit" && status.problem?.kind === "limit" ? status.problem.resetsAt : undefined;
  // Connected and not refused: a key the provider rejects is connected too, and still holds the message.
  return { spec, kind, problem, resetsAt, resolved: kind === "credential" && status.connected && !status.problem?.credential, machine: machineName(status.device) };
}

export type CloudAgentSetupCard = NonNullable<ReturnType<typeof useCloudAgentSetupCard>>;

const ACTION_ICONS: Record<CloudAgentActionName, ComponentType<{ className?: string }>> = {
  create_pr: GitPullRequest,
  apply: Download,
  archive: Archive,
  unarchive: ArchiveRestore,
};

/** Why an ask task has no Create PR or Apply: it answers without changing code. */
const ASK_HAS_NO_CHANGES = "An ask task answers without changing code";

/** One of the provider's actions as a surface lists it: shown only when it applies, disabled with the reason when it cannot run. */
export interface CloudAgentActionItem {
  action: CloudAgentActionName;
  label: string;
  title: string;
  Icon: ComponentType<{ className?: string }>;
  disabledReason?: string;
}

/**
 * The provider's actions on a session's cloud agent (its spec lists which),
 * as every surface offers them: the header chip, the session menu and the
 * command palette. Archive or Unarchive, whichever the agent's state takes;
 * Create PR and Apply disabled for an ask task; none until the agent exists.
 * The owner only; the machine that hosts the session runs them, says the
 * result in the thread, and a toast says it here (a pull request with a
 * button that opens it). Called once per conversation view and handed to
 * each surface, so one pending action shows everywhere and its outcome is
 * still watched after the menu that started it closes. `problem`: what the
 * machine that drives the session reports in the provider's way (it may
 * have stopped syncing), for the header to say.
 */
export function useCloudAgentActions(conversationId: string | undefined, canAct: boolean) {
  const cloud = useCloudAgentOfConversation(conversationId);
  const { problem } = useCloudAgentStatus(cloud?.spec, useLiveSessionMeta(conversationId)?.ownerDeviceId);
  const { run, pending } = useCloudAgentAction(conversationId ?? "", ({ ok, text, url }) => {
    if (!ok) toast.error(text);
    else if (url) toast.success(text, { action: { label: "Open PR", onClick: () => window.open(url, "_blank", "noopener") } });
    else toast.success(text);
  });
  const items: CloudAgentActionItem[] = !cloud?.agentId || !canAct ? [] : (cloud.spec.actions ?? [])
    .filter((action) => action !== (cloud.archived ? "archive" : "unarchive"))
    .map((action) => ({
      action,
      label: CLOUD_AGENT_ACTIONS[action].label,
      title: CLOUD_AGENT_ACTIONS[action].title,
      Icon: ACTION_ICONS[action],
      ...(CLOUD_AGENT_ACTIONS[action].needsChanges && cloud.launch?.ask ? { disabledReason: ASK_HAS_NO_CHANGES } : {}),
    }));
  // The command palette's session actions: the ones that can run now.
  const palette = items.filter((i) => !i.disabledReason).map((i) => ({
    key: `cloud_${i.action}`,
    label: `${cloud!.spec.label}: ${i.label}`,
    icon: i.Icon,
    available: !pending,
    run: () => void run(i.action),
  }));
  return { cloud, items, run, pending, palette, problem };
}

export type CloudAgentActions = ReturnType<typeof useCloudAgentActions>;
