// /confirm?c=<challenge id>: where the desktop app and the phone send a Touch
// ID confirmation, since only a real browser runs platform passkeys
// (lib/passkeyPresence, vault.md "Touch ID"). It works signed out: the
// challenge id names the person and only their passkey verifies. The app that
// opened it is watching the same challenge and goes on by itself once it is
// granted. An agent's tab may not run it.
import { useState } from "react";
import { useConvex } from "convex/react";
import { useSearchParams } from "next/navigation";
import { Check, Clock, Fingerprint, Loader2, Lock } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { PRESENCE_PHRASE } from "@codecast/shared/contracts/secrets";
import { KeyCap } from "../../components/KeyCap";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useEventListener } from "../../hooks/useEventListener";
import { PERSON_ONLY, useAgentDrivenTab } from "../../lib/agentTabGuard";
import { finishPresence, finishRegistration } from "../../lib/passkeyPresence";
import { VAULT_PRIMARY } from "../../lib/secretLook";

function Frame({ icon, title, sub, children }: { icon: React.ReactNode; title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-sol-bg flex items-center justify-center px-4" data-confirm-page>
      <div className="w-full max-w-sm rounded-xl border border-sol-border bg-sol-bg-alt/50 p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sol-bg text-sol-text-muted">{icon}</div>
        <h1 className="text-lg font-semibold text-sol-text">{title}</h1>
        {sub && <p className="mt-1 break-words text-sm text-sol-text-muted" data-confirm-sub>{sub}</p>}
        {children}
      </div>
    </main>
  );
}

export default function ConfirmPage() {
  const id = useSearchParams()?.get("c") ?? "";
  const client = useConvex();
  // A failed read degrades to "Nothing to confirm" rather than an error screen.
  const { data: state, error } = useQueryNoThrow(api.passkeys.challenge, id ? { challenge_id: id } : "skip");
  const agentTab = useAgentDrivenTab();
  const [busy, setBusy] = useState(false);

  const pending = state?.status === "pending" && "options" in state ? state : null;
  const register = state?.purpose === "register";
  const held = agentTab ? (register ? PERSON_ONLY.enroll : PERSON_ONLY.confirm) : undefined;
  const run = async () => {
    if (!pending || busy || held) return;
    setBusy(true);
    try {
      await (register ? finishRegistration : finishPresence)(client, id, pending.options);
    } finally {
      setBusy(false);
    }
  };
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") void run();
  });

  if (id && state === undefined && !error) return <Frame icon={<Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />} title="Loading" />;
  if (!state) return <Frame icon={<Fingerprint className="h-5 w-5" />} title="Nothing to confirm" sub="Start again from Codecast" />;
  if (state.status === "granted" || state.status === "used") {
    return <Frame icon={<Check className="h-5 w-5 text-sol-green" />} title={register ? "Touch ID is set up" : "Confirmed"} sub="Back to Codecast: it carries on by itself" />;
  }
  if (!pending) return <Frame icon={<Clock className="h-5 w-5" />} title="This confirmation expired" sub="Start again from Codecast" />;

  const title = register ? "Set up Touch ID" : `Confirm to ${PRESENCE_PHRASE[pending.action!]}`;
  return (
    <Frame icon={<Fingerprint className="h-5 w-5 text-sol-cyan" />} title={title} sub={pending.label}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || !!held}
        title={held}
        className={`mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm ${VAULT_PRIMARY}`}
        data-confirm-run
      >
        {held ? <Lock className="h-4 w-4" /> : busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Fingerprint className="h-4 w-4" />}
        {held ?? (register ? "Set up Touch ID" : "Confirm with Touch ID")}
        {!held && !busy && <KeyCap size="xs" tone="onAccent">return</KeyCap>}
      </button>
    </Frame>
  );
}
