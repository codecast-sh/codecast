import { useRef, useState, useCallback } from "react";
import { useMountEffect } from "./useMountEffect";
import { toast } from "sonner";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import type { ConversationData } from "../components/conversation/types";

export function usePermissionModeSwitch({ effectiveMode, conversation, effectiveIsOwner, convexConvId, convCommand }: {
  effectiveMode: string;
  conversation: ConversationData | null | undefined;
  effectiveIsOwner: boolean;
  convexConvId: Id<"conversations"> | undefined;
  convCommand: (convId: string, command: string, extraArgs?: Record<string, any>, optimistic?: Record<string, any>) => Promise<any>;
}) {
  const [switchingFrom, setSwitchingFrom] = useState<string | null>(null);
  const modeSwitching = switchingFrom !== null && switchingFrom === effectiveMode;
  const modeSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMountEffect(() => () => { if (modeSwitchTimerRef.current) clearTimeout(modeSwitchTimerRef.current); });
  const requestPermissionMode = useCallback((target?: string) => {
    // convexConvId is undefined until the session exists server-side; a not-yet-started
    // draft carries a stub id and has no live process to receive keystrokes.
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !convexConvId) return;
    const from = useInboxStore.getState().sessions[convexConvId]?.permission_mode || "default";
    setSwitchingFrom(from);
    if (modeSwitchTimerRef.current) clearTimeout(modeSwitchTimerRef.current);
    modeSwitchTimerRef.current = setTimeout(() => setSwitchingFrom(null), 6000);
    void convCommand(convexConvId, "setPermissionMode", target ? { target } : {}).catch((err) => {
      setSwitchingFrom(null);
      if (isParkedDispatchError(err)) return;
      toast.error(err instanceof Error ? err.message : "Failed to change permission mode");
    });
  }, [conversation, effectiveIsOwner, convCommand, convexConvId]);
  const handleCycleMode = useCallback(() => requestPermissionMode(), [requestPermissionMode]);
  const handleEnableBypass = useCallback(() => requestPermissionMode("bypassPermissions"), [requestPermissionMode]);

  return { handleCycleMode, modeSwitching, handleEnableBypass };
}
