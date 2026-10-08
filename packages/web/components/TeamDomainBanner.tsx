import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Users, X } from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A coworker's team is on codecast and open to the person's work domain
 * (convex/teamDiscovery.ts): name it and let them ask to join. An address not
 * yet proven learns only that a team may be waiting, and proves it here with
 * a code. Dismissed for a week at a time.
 */
export function TeamDomainBanner() {
  const found = useQueryNoThrow(api.teamDiscovery.teamsForMyDomain, {}).data;
  const dismissedAt = useInboxStore((s) => s.clientState.dismissed?.team_domain ?? 0);
  const dismiss = useInboxStore((s) => s.updateClientDismissed);
  const sendCode = useMutation(api.teamDiscovery.sendWorkEmailCode);
  const confirmCode = useMutation(api.teamDiscovery.confirmWorkEmailCode);
  const requestToJoin = useMutation(api.teamDiscovery.requestToJoin);
  const [phase, setPhase] = useState<"idle" | "sending" | "code" | "checking">("idle");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState<string | null>(null);

  if (!found || Date.now() - dismissedAt < DISMISS_FOR_MS) return null;
  const open = found.teams.filter((t) => t.request !== "declined");
  if (!found.needs_proof && open.length === 0) return null;

  const fail = (err: unknown) => setError(humanizeConvexError(err));
  const startProof = () => {
    setError("");
    setPhase("sending");
    sendCode({}).then(() => setPhase("code")).catch((err) => { fail(err); setPhase("idle"); });
  };
  const checkCode = () => {
    setError("");
    setPhase("checking");
    confirmCode({ code }).then(() => setPhase("idle")).catch((err) => { fail(err); setPhase("code"); });
  };
  const ask = (teamId: Id<"teams">) => {
    setError("");
    setAsking(teamId);
    requestToJoin({ team_id: teamId }).catch(fail).finally(() => setAsking(null));
  };

  let body: React.ReactNode;
  if (found.needs_proof) {
    body = phase === "code" || phase === "checking" ? (
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); checkCode(); }}>
        <span className="text-sm text-sol-text">Enter the code we emailed you</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoFocus
          className="w-24 rounded border border-sol-border bg-sol-bg px-2 py-0.5 font-mono text-sm text-sol-text"
          aria-label="Code"
        />
        <button type="submit" disabled={code.length !== 6 || phase === "checking"} className="text-sm font-medium text-sol-violet disabled:opacity-50">
          Confirm
        </button>
      </form>
    ) : (
      <>
        <span className="text-sm text-sol-text">
          Someone at <span className="font-mono">@{found.domain}</span> may already be on codecast. Confirm your email to see their team.
        </span>
        <button onClick={startProof} disabled={phase === "sending"} className="shrink-0 text-sm font-medium text-sol-violet disabled:opacity-50">
          {phase === "sending" ? "Sending…" : "Email me a code"}
        </button>
      </>
    );
  } else {
    body = open.map((t) => (
      <span key={t._id} className="flex items-center gap-3">
        <span className="text-sm text-sol-text">
          <span className="font-medium">{t.name}</span> is on codecast ({t.member_count} {t.member_count === 1 ? "person" : "people"} from @{found.domain}).
        </span>
        {t.request === "pending" ? (
          <span className="shrink-0 text-sm text-sol-text-muted">Asked. An admin will let you in.</span>
        ) : (
          <button onClick={() => ask(t._id)} disabled={asking === t._id} className="shrink-0 text-sm font-medium text-sol-violet disabled:opacity-50">
            {asking === t._id ? "Asking…" : "Ask to join"}
          </button>
        )}
      </span>
    ));
  }

  return (
    <div data-cc-banner className="border-b border-sol-violet/30 bg-sol-violet/10">
      <div className="flex items-center justify-between gap-4 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Users className="h-4 w-4 shrink-0 text-sol-violet" />
          {body}
          {error && <span className="text-sm text-sol-red">{error}</span>}
        </div>
        <button
          onClick={() => dismiss("team_domain", Date.now())}
          className="p-1 text-sol-text-dim transition-colors hover:text-sol-text"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
