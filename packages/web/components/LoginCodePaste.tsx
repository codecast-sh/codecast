// Finish a machine's pending `claude auth login` from wherever the person is:
// open the code-paste sign-in page the daemon reported, then paste the code
// that page shows. The daemon types it into the waiting CLI (submitLoginCode).
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";

export function LoginCodePaste({ deviceId, flow }: { deviceId: string; flow: { url?: string; started_at: number } }) {
  const submit = useMutation(api.accountSwitch.submitLoginCode);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  if (!flow.url) return null;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 block text-left font-medium text-amber-500 underline underline-offset-2 hover:text-amber-400">
        Not at that machine? Sign in here with a code
      </button>
    );
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      await submit({ device_id: deviceId, started_at: flow.started_at, code });
      setCode("");
      toast.message("Code sent. Waiting for the machine to finish signing in.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send the code");
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={send} className="mt-1.5 flex flex-col gap-1.5">
      <a href={flow.url} target="_blank" rel="noreferrer" className="font-medium text-amber-500 underline underline-offset-2 hover:text-amber-400">
        1. Open the sign-in page
      </a>
      <div className="flex items-center gap-1.5">
        <input
          aria-label="Approval code"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.trim())}
          placeholder="2. Paste the code it shows"
          className="h-7 min-w-0 flex-1 rounded border border-sol-border bg-sol-bg px-2 font-mono text-[11px] text-sol-text"
        />
        <button type="submit" disabled={sending || !code} className="h-7 rounded bg-amber-500 px-2.5 text-[11px] font-bold text-sol-bg disabled:opacity-60">
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
