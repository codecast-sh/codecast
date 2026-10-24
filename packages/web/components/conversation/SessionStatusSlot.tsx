import { useInboxStore } from "../../store/inboxStore";
import { useInterruptVerdict } from "../../hooks/useSessionCommands";
import { AgentStatusPill } from "./ConversationHeaderBar";

/**
 * The header's status slot. Normally the agent's status; when this window's
 * last stop went wrong, the verdict takes its place (the press painted the
 * session idle, so the status would say it stopped) with the one action that
 * fixes it: press stop again, or restart a session with no agent to stop.
 * Its own component so the verdict's clock re-renders only this.
 */
export function SessionStatusSlot({
  conversationId,
  agentStatus,
  disconnected,
  live,
  onRestart,
}: {
  conversationId: string | undefined;
  agentStatus: string | undefined;
  disconnected: boolean;
  live: boolean;
  onRestart: () => void;
}) {
  const { row, verdict } = useInterruptVerdict(conversationId);
  if (!verdict || !row || !conversationId) return <AgentStatusPill agentStatus={agentStatus} disconnected={disconnected} live={live} />;
  const failed = verdict === "failed";
  const act = () => {
    const store = useInboxStore.getState();
    if (failed) {
      store.dismissSessionCommand(row._id);
      onRestart();
    } else {
      void store.sendEscape(conversationId).catch(() => {});
    }
  };
  const tone = failed ? "text-sol-red" : "text-sol-yellow";
  const chip = failed ? "border-sol-red/40 hover:bg-sol-red/10" : "border-sol-yellow/40 hover:bg-sol-yellow/10";
  return (
    <span
      data-cc-conv-status
      data-interrupt-verdict={verdict}
      className={`inline-flex items-center gap-1 px-1 text-[10px] flex-shrink-0 ${tone}`}
      title={failed ? row.error ?? undefined : "No machine took the stop"}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${failed ? "bg-sol-red" : "bg-sol-yellow"}`} />
      <span className="hidden sm:inline cq-sq3">{failed ? "Stop failed" : "Stop not delivered"}</span>
      <button
        type="button"
        onClick={act}
        className={`px-1 rounded border transition-colors ${chip}`}
      >
        {failed ? "Restart" : "Stop again"}
      </button>
    </span>
  );
}
