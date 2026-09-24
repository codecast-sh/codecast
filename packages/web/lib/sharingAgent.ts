// "Set up with an agent": a fresh session that walks the person through what
// syncs to codecast and what each team sees, using `cast sharing`. The
// onboarding strip and the Sync & Privacy page both start it through here.
import { toast } from "sonner";
import { useInboxStore, defaultNewSessionPath } from "../store/inboxStore";
import { spawnSessionWithPrompt } from "./spawnSession";
import { openConversationBeside } from "../hooks/useOpenLinkedSession";

export const SHARING_AGENT_PROMPT = `Help me decide what syncs to codecast and what my teams can see, then set it up.

\`cast sharing\` shows the whole picture: my teams and how much each sees, and every folder with its session counts, whether it syncs, and who can open it. \`cast sharing --help\` explains the model and every change, and \`cast sharing sessions <folder>\` shows what a folder holds. If \`cast sharing\` does not exist, run \`cast update\` first.

Read the current state and look into the folders that need a decision before you ask me anything. Then give me a short summary and one recommendation per folder, grouped so I can answer in a reply or two: keep syncing or stop, private, shared with which team and from when, or locked. Ask only about what you cannot judge from names and session titles, such as client work, personal projects or anything sensitive.

Change nothing until I agree. Before a share that opens past sessions to a team, or anything that deletes, show me what it exposes with \`--dry-run\` and wait for my yes. When we are done, show the new picture and how to undo each change.`;

/** Start the agent, keep its conversation private, and put it on screen:
 *  beside the current page when there is room, so the settings it changes
 *  are in view, else on the stage. */
export function startSharingAgent(): string {
  const st = useInboxStore.getState();
  const { stubId } = spawnSessionWithPrompt({
    prompt: SHARING_AGENT_PROMPT,
    projectPath: defaultNewSessionPath(st),
    private: true,
    failureLabel: "Failed to start the sharing setup session",
  });
  // Started from the settings modal, the modal would cover the conversation;
  // the page it showed is one click away in the sidebar.
  if (st.settingsModalSection) st.closeSettingsModal();
  openConversationBeside(stubId);
  return stubId;
}

export function launchSharingAgent(): void {
  startSharingAgent();
  toast.success("Agent started", {
    description: "It reads your folders first, then asks you. Nothing changes until you agree.",
  });
}
