// The code field under a hosted conversation's `verify` stop
// (convex/assistant/freeGate.ts): the Free plan serves a person once they
// prove their email, so the stop mailed them a code, and entering it here
// proves the address and picks the stopped ask up again
// (assistant.entry.confirmEmailProof). The web notice and the phone's notice
// both read this hook, so the two never disagree about what a code does.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { humanizeConvexError } from "@codecast/shared/contracts";

/** How many digits the mailed code has (lib/emailProof). */
export const EMAIL_PROOF_DIGITS = 6;

export function useEmailProof(conversationId: string | undefined) {
  const confirm = useMutation(api.assistant.entry.confirmEmailProof);
  const send = useMutation(api.assistant.entry.sendEmailProof);
  const [code, setCodeRaw] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"idle" | "checking" | "sending" | "sent" | "done">("idle");

  const setCode = (value: string) => {
    setCodeRaw(value.replace(/\D/g, "").slice(0, EMAIL_PROOF_DIGITS));
    if (error) setError("");
  };
  const ready = code.length === EMAIL_PROOF_DIGITS && phase !== "checking" && phase !== "done";

  const submit = async () => {
    if (!ready) return;
    setPhase("checking");
    setError("");
    try {
      await confirm({ code, ...(conversationId ? { conversation_id: conversationId as Id<"conversations"> } : {}) });
      setPhase("done");
    } catch (err) {
      setError(humanizeConvexError(err, "That code didn't work. Try again or send a new one."));
      setPhase("idle");
    }
  };

  const resend = async () => {
    if (phase === "sending" || phase === "checking") return;
    setPhase("sending");
    setError("");
    setCodeRaw("");
    try {
      await send({});
      setPhase("sent");
    } catch (err) {
      setError(humanizeConvexError(err, "Couldn't send a new code. Try again in a little while."));
      setPhase("idle");
    }
  };

  return { code, setCode, ready, error, phase, submit, resend };
}
