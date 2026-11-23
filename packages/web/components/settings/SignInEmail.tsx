"use client";

// The address the account signs in with, and the way to move the account to
// another one (convex/accountEmail.ts): type the new address, enter the code
// mailed to it, and the account answers to it from then on. The address it
// left joins the other addresses below, so nothing found under it is lost.
import { useState } from "react";
import { useMutation } from "convex/react";
import { Check, Mail } from "lucide-react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./ui";

/** How many digits the mailed code has (convex/lib/emailProof). */
const CODE_DIGITS = 6;

export function SignInEmail() {
  const { user } = useCurrentUser();
  const requestChange = useMutation(api.accountEmail.requestEmailChange);
  const confirmChange = useMutation(api.accountEmail.confirmEmailChange);
  const [step, setStep] = useState<"closed" | "address" | "code">("closed");
  const [address, setAddress] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"" | "sending" | "checking">("");
  const [error, setError] = useState("");

  const current: string | undefined = (user as any)?.email || undefined;

  const close = () => {
    setStep("closed");
    setAddress("");
    setSentTo("");
    setCode("");
    setError("");
  };

  const send = async (to: string) => {
    if (!to.trim() || busy) return;
    setBusy("sending");
    setError("");
    try {
      const sent = await requestChange({ email: to.trim() });
      setSentTo(sent.sent_to);
      setCode("");
      setStep("code");
    } catch (err) {
      setError(humanizeConvexError(err, "Couldn't send a code to that address"));
    } finally {
      setBusy("");
    }
  };

  const confirm = async () => {
    if (code.length !== CODE_DIGITS || busy) return;
    setBusy("checking");
    setError("");
    try {
      const result = await confirmChange({ email: sentTo, code });
      if (!result.changed) {
        setError(result.error);
        return;
      }
      toast.success(`You now sign in as ${result.email}`);
      close();
    } catch (err) {
      setError(humanizeConvexError(err, "That code didn't work. Send a new one."));
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <SettingsRow
        icon={Mail}
        label="Email"
        description={
          current ? (
            <span className="inline-flex items-center gap-1 text-sol-green">
              <Check className="h-3.5 w-3.5" />
              {current}
            </span>
          ) : (
            "Not configured"
          )
        }
      >
        {step === "closed" && (
          <Button variant="outline" size="sm" onClick={() => setStep("address")}>
            {current ? "Change" : "Add"}
          </Button>
        )}
      </SettingsRow>

      {step === "address" && (
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            void send(address);
          }}
        >
          <Input
            type="email"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              if (error) setError("");
            }}
            placeholder="you@work.example"
            aria-label="New sign-in address"
            autoComplete="email"
            autoFocus
            className="h-8 min-w-0 flex-1 text-sm"
          />
          <Button type="submit" variant="cyan" size="sm" disabled={!address.trim() || busy === "sending"}>
            {busy === "sending" ? "Sending…" : "Email me a code"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          {error && <p className="basis-full text-xs text-sol-red" role="alert">{error}</p>}
        </form>
      )}

      {step === "code" && (
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <label htmlFor="sign-in-email-code" className="min-w-0 flex-1 truncate text-sm text-sol-text">
            Code sent to <span className="font-mono">{sentTo}</span>
          </label>
          <Input
            id="sign-in-email-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_DIGITS));
              if (error) setError("");
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            className="h-8 w-28 font-mono text-sm tracking-widest"
          />
          <Button type="submit" variant="cyan" size="sm" disabled={code.length !== CODE_DIGITS || busy === "checking"}>
            {busy === "checking" ? "Checking…" : "Confirm"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy === "sending"} onClick={() => void send(sentTo)}>
            {busy === "sending" ? "Sending…" : "Send a new code"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          {error && <p className="basis-full text-xs text-sol-red" role="alert">{error}</p>}
        </form>
      )}
    </>
  );
}
