import { useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { useWorkflows } from "./useSyncWorkflows";
import type { ConversationData } from "../components/conversation/types";

const api = _typedApi as any;

export function useWorkflowLaunch({ workflowRun, conversation }: {
  workflowRun: { _id: string; status: string; gate_prompt?: string; gate_choices?: Array<{ key: string; label: string; target: string; }>; gate_response?: string | null; } | null | undefined;
  conversation: ConversationData | null | undefined;
}) {
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [gateResponding, setGateResponding] = useState(false);
  const handleGateRespond = useCallback(async (text: string) => {
    if (!workflowRun || !text.trim()) return;
    setGateResponding(true);
    try { await respondToGate({ id: workflowRun._id as any, response: text.trim() }); } finally { setGateResponding(false); }
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

  return { gateResponding, handleGateChoice, handleGateRespond, showWorkflow, setShowWorkflow, selectedWorkflowId, setSelectedWorkflowId, workflows, handleWorkflowLaunch };
}
