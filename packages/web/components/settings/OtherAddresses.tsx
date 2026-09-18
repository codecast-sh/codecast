"use client";

// The other email addresses this person uses. One person often has several: a
// work address in the Slack workspace, a personal one here, an old one on past
// commits. Everywhere codecast resolves a person BY address — a Slack line, a
// task assignee, who belongs on a thread — it reads these beside the primary,
// so adding one here is how you say "that is also me" once instead of matching
// the same person by hand in each place.
import { useMutation } from "convex/react";
import { useState } from "react";
import { AlertTriangle, Mail, Plus, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useCurrentUser } from "../../hooks/useCurrentUser";

export function OtherAddresses() {
  const { user } = useCurrentUser();
  const addEmail = useMutation(api.users.addAlternateEmail);
  const removeEmail = useMutation(api.users.removeAlternateEmail);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addresses: string[] = (user as any)?.alternate_emails ?? [];

  const add = async () => {
    const email = value.trim();
    if (!email || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await addEmail({ email } as any);
      setValue("");
    } catch (e: any) {
      setErr(e?.data?.message ?? e?.message ?? "Couldn't add that address");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (email: string) => {
    setBusy(true);
    setErr(null);
    try {
      await removeEmail({ email } as any);
    } catch (e: any) {
      setErr(e?.data?.message ?? e?.message ?? "Couldn't remove that address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2 text-sm text-sol-text">
        <Mail className="h-4 w-4 text-sol-text-dim" />
        Other addresses
      </div>
      <p className="mt-1 text-xs leading-relaxed text-sol-text-muted">
        Addresses you use elsewhere. A Slack person, a task assignee or a thread member found under one of
        these is you. Adding one claims what has already been seen under it.
      </p>

      {addresses.length > 0 && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {addresses.map((email) => (
            <li
              key={email}
              className="inline-flex items-center gap-1.5 rounded-md border border-sol-border/70 bg-sol-bg-alt/40 py-1 pl-2.5 pr-1 text-xs text-sol-text"
            >
              {email}
              <button
                type="button"
                onClick={() => remove(email)}
                disabled={busy}
                aria-label={`Remove ${email}`}
                title="Remove"
                className="rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-2.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="you@work.example"
          aria-label="Another address you use"
          className="h-8 min-w-0 flex-1 rounded-md border border-sol-border/70 bg-sol-bg px-2.5 text-xs text-sol-text outline-none placeholder:text-sol-text-dim/60 focus:border-sol-cyan"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-sol-border px-2.5 text-xs text-sol-text hover:bg-sol-bg-highlight disabled:opacity-50"
        >
          <Plus className="h-3 w-3" /> Add
        </button>
      </form>

      {err && (
        <div className="mt-2 inline-flex items-start gap-1.5 text-xs text-sol-red">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {err}
        </div>
      )}
    </div>
  );
}
