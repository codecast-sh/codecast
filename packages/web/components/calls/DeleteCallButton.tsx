"use client";
// A call of a team whose data is regulated, deleted for good by a team admin:
// its recordings, its transcript and the call record (convex
// regulatedDeletion.deleteCall), through the shared review. Shown only to
// those admins, and only once the call has ended.
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { CALL_REACHES, permanentDeleteLedger, regulatedTeam } from "../consequential/deletionLedgers";
import { humanizeConvexError } from "@codecast/shared/contracts";

export function DeleteCallButton({ call, live, title }: { call: { _id: unknown; team_id?: unknown; segments?: unknown[] }; live: boolean; title: string }) {
  const teams = useInboxStore((s) => s.teams);
  const team = regulatedTeam(teams, call.team_id);
  const [reviewing, setReviewing] = useState(false);
  const router = useRouter();
  if (!team?.admin || live) return null;
  const confirm = () => {
    setReviewing(false);
    router.push("/calls");
    useInboxStore.getState().deleteCall(String(call._id)).then(
      () => toast.success("Call deleted"),
      (err: unknown) => toast.error(humanizeConvexError(err)),
    );
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setReviewing(true)}
        className="flex items-center rounded p-1 text-sol-text-dim transition-colors hover:bg-sol-red/10 hover:text-sol-red"
        aria-label="Delete this call permanently"
        data-delete-call
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      {reviewing && (
        <SwitchReview
          ledger={permanentDeleteLedger({
            what: "call",
            title,
            team: team.name,
            figures: [{ value: String(call.segments?.length ?? 0), label: "transcript lines", tone: "warn" }],
            reaches: CALL_REACHES,
          })}
          onClose={() => setReviewing(false)}
          onConfirm={confirm}
        />
      )}
    </>
  );
}
