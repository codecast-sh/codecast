import { toast } from "sonner";
import { commitModelChange as commitModelChangeCore } from "./modelSwitch";

// Web commit path for model/effort switches: the shared rails in modelSwitch.ts
// plus sonner toasts for errors. Every web initiator (header badge, launch pill,
// Cmd+K palette) funnels through here. Kept out of ModelEffortPicker.tsx so that
// module exports only components and stays a Fast Refresh boundary.

export const notifyModelToast = (message: string) => toast.error(message);

export function commitModelChange(opts: {
  conversationId: string;
  agentType: string | undefined;
  current: { model?: string | null; effort?: string | null };
  sel: { model?: string; effort?: string };
  blank: boolean;
}): Promise<void> {
  return commitModelChangeCore({ ...opts, notify: notifyModelToast });
}
