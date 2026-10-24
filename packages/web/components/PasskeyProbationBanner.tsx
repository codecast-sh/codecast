import { Fingerprint, Loader2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { inProbation, type PasskeyMeta } from "@codecast/shared/contracts/secrets";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useInboxStore } from "../store/inboxStore";
import { probationHours, useRemovePasskey } from "../hooks/useRemovePasskey";

/**
 * A passkey set up with no grant behind it (an account's first, which an
 * agent holding the person's sign-in could have added) shows on every screen
 * until its probation ends, with Remove one press away. It is not
 * dismissable: whoever added it must not be able to hide it from the person.
 */
export function PasskeyProbationBanner() {
  const passkeys = useQueryNoThrow(api.passkeys.list, {}).data;
  const fresh = passkeys?.find((p) => inProbation(p));
  return fresh ? <ProbationRow passkey={fresh} count={passkeys!.length} /> : null;
}

function ProbationRow({ passkey, count }: { passkey: PasskeyMeta; count: number }) {
  const { drop, removing, error } = useRemovePasskey(passkey, count);
  return (
    <div data-cc-banner data-passkey-probation-banner className="border-b border-sol-orange/30 bg-sol-orange/10">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <Fingerprint className="h-4 w-4 shrink-0 text-sol-orange" />
        <span className="text-sol-text">
          New passkey <span className="font-medium">{passkey.name}</span>
        </span>
        <span className="text-sol-text-muted">confirms in {probationHours(passkey)}h</span>
        <button type="button" onClick={() => useInboxStore.getState().openSettingsModal("accounts")} className="font-medium text-sol-text-muted hover:text-sol-text">
          Review
        </button>
        <button type="button" onClick={() => void drop()} disabled={removing} className="inline-flex items-center gap-1 font-medium text-sol-red disabled:opacity-50" data-passkey-probation-remove>
          {removing && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
          Remove
        </button>
        {error && <span className="text-sol-red">{error}</span>}
      </div>
    </div>
  );
}
