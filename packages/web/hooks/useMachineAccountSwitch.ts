"use client";

// Machine-wide Claude account switch. The mutation only queues a daemon
// command; this hook watches that command (and the heartbeat's active_email)
// and holds "switching" until the swap lands or fails. Shared by the header
// chip and Settings so neither surface can toast success on queue.

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  machineSwitchPendingCopy,
  machineSwitchSuccessCopy,
  profileIsCurrentLogin,
  resolveMachineSwitch,
  type MachineSwitchPhase,
} from "../lib/machineAccountSwitch";
import { useCoarseNow } from "./useCoarseNow";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export type MachineSwitchOutcome = {
  kind: "success" | "error";
  profile: string;
  message: string;
};

type PendingSwitch = {
  profile: string;
  email?: string;
  commandId: Id<"daemon_commands"> | null;
  startedAt: number;
  toastId: string;
};

export function useMachineAccountSwitch(opts: { deviceId?: string; activeEmail?: string }): {
  switchTo: (profile: string, email?: string) => Promise<void>;
  cancel: () => void;
  switching: string | null;
  phase: MachineSwitchPhase;
  outcome: MachineSwitchOutcome | null;
  clearOutcome: () => void;
} {
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [outcome, setOutcome] = useState<MachineSwitchOutcome | null>(null);
  const { data: cmd } = useQueryNoThrow(
    api.users.getCommandResult,
    pending?.commandId ? { command_id: pending.commandId } : "skip",
  );
  const now = useCoarseNow(pending ? 1_000 : 30_000);
  const resolved = resolveMachineSwitch({
    pending,
    activeEmail: opts.activeEmail,
    command: cmd ?? undefined,
    now,
  });
  const announced = useRef<string | null>(null);

  useWatchEffect(() => {
    if (!pending) return;
    if (resolved.phase === "slow") {
      const key = `${pending.profile}:slow`;
      if (announced.current === key) return;
      announced.current = key;
      toast.message(machineSwitchPendingCopy("slow", pending.profile), { id: pending.toastId, duration: Infinity });
      return;
    }
    if (resolved.phase === "succeeded") {
      const key = `${pending.profile}:ok`;
      if (announced.current === key) return;
      announced.current = key;
      toast.success(machineSwitchSuccessCopy(pending.profile), { id: pending.toastId });
      setOutcome({ kind: "success", profile: pending.profile, message: `Now using ${pending.profile}` });
      setPending(null);
      return;
    }
    if (resolved.phase === "failed") {
      const key = `${pending.profile}:err`;
      if (announced.current === key) return;
      announced.current = key;
      const message = resolved.error ?? "Switch failed";
      toast.error(message, { id: pending.toastId, duration: 12_000 });
      setOutcome({ kind: "error", profile: pending.profile, message });
      setPending(null);
    }
  }, [pending, resolved.phase, resolved.error]);

  const cancel = () => {
    if (!pending) return;
    toast.dismiss(pending.toastId);
    announced.current = `${pending.profile}:cancel`;
    setPending(null);
    setOutcome(null);
  };

  const switchTo = async (profile: string, email?: string) => {
    if (!opts.deviceId) {
      toast.error("No online daemon to switch accounts");
      return;
    }
    if (profileIsCurrentLogin({ name: profile, email }, opts.activeEmail)) {
      toast.success(`Already on "${profile}"`);
      setOutcome({ kind: "success", profile, message: `Already using ${profile}` });
      if (pending) {
        toast.dismiss(pending.toastId);
        setPending(null);
      }
      return;
    }
    if (pending?.profile === profile) return;
    const toastId = `acct-switch-${opts.deviceId}`;
    announced.current = null;
    setOutcome(null);
    setPending({ profile, email, commandId: null, startedAt: Date.now(), toastId });
    toast.message(machineSwitchPendingCopy("waiting", profile), { id: toastId, duration: Infinity });
    try {
      const res = await requestSwitch({
        profile,
        device_id: opts.deviceId,
        continue_blocked: false,
      });
      const commandId = (res.command_ids?.[0] ?? null) as Id<"daemon_commands"> | null;
      setPending((cur) => (cur && cur.profile === profile ? { ...cur, commandId } : cur));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Switch failed";
      toast.error(message, { id: toastId, duration: 12_000 });
      setOutcome({ kind: "error", profile, message });
      setPending((cur) => (cur && cur.profile === profile ? null : cur));
    }
  };

  return {
    switchTo,
    cancel,
    switching: pending?.profile ?? null,
    phase: pending ? resolved.phase : outcome?.kind === "error" ? "failed" : outcome?.kind === "success" ? "succeeded" : "idle",
    outcome,
    clearOutcome: () => setOutcome(null),
  };
}
