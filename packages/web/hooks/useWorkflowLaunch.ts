import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { useWorkflows } from "./useSyncWorkflows";
import { useInboxStore } from "../store/inboxStore";
import type { ConversationData } from "../components/conversation/types";

const api = _typedApi as any;

export function useWorkflowLaunch({ workflowRun, conversation }: {
  workflowRun: { _id: string; status: string; gate_prompt?: string; gate_choices?: Array<{ key: string; label: string; target: string; }>; gate_response?: string | null; } | null | undefined;
  conversation: ConversationData | null | undefined;
}) {
  // Local-first (store respondToGate): the run flips to running on the press.
  const respondToGate = useInboxStore((s) => s.respondToGate);
  const handleGateRespond = useCallback((text: string) => {
    if (!workflowRun || !text.trim()) return;
    respondToGate(workflowRun._id, text.trim());
  }, [workflowRun, respondToGate]);
  const handleGateChoice = handleGateRespond;

  const [showWorkflow, setShowWorkflow] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const { workflows } = useWorkflows();
  const createWorkflowRun = useMutation(api.workflow_runs.create);
  const handleWorkflowLaunch = useCallback(async (goal: string) => {
    if (!selectedWorkflowId) return;
    try {
      await createWorkflowRun({
        workflow_id: selectedWorkflowId,
        goal_override: goal || undefined,
        project_path: conversation?.project_path || undefined,
        existing_conversation_id: conversation?._id as any,
      });
      toast.success("Workflow started");
      setShowWorkflow(false);
      setSelectedWorkflowId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start workflow");
    }
  }, [selectedWorkflowId, createWorkflowRun, conversation?.project_path, conversation?._id]);

  return { handleGateChoice, handleGateRespond, showWorkflow, setShowWorkflow, selectedWorkflowId, setSelectedWorkflowId, workflows, handleWorkflowLaunch };
}
