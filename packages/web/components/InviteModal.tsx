import { useState } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useTrackedStore, isConvexId } from "../store/inboxStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { InvitePanel } from "./team/InvitePanel";

interface InviteModalProps {
  /** Team to invite into. Defaults to the active team, then the user's home team. */
  teamId?: Id<"teams">;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Thin dialog around InvitePanel. */
export function InviteModal({ teamId, trigger, open: controlledOpen, onOpenChange }: InviteModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { user } = useCurrentUser();
  const activeTeamId = useTrackedStore([(s) => s.clientState.ui?.active_team_id]).clientState.ui
    ?.active_team_id as Id<"teams"> | undefined;
  // isConvexId: a just-created team holds an optimistic stub id until the
  // server echoes, and InvitePanel hands the id to server queries.
  const serverActiveTeamId = activeTeamId && isConvexId(String(activeTeamId)) ? activeTeamId : undefined;
  const effectiveTeamId = teamId ?? serverActiveTeamId ?? user?.team_id;

  if (!effectiveTeamId) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="bg-sol-bg border-sol-border">
        <DialogHeader>
          <DialogTitle className="text-sol-text">Invite Team Member</DialogTitle>
          <DialogDescription className="text-sol-base1">
            Share this link with your team members
          </DialogDescription>
        </DialogHeader>
        {open && <InvitePanel teamId={effectiveTeamId} variant="modal" />}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            className="border-sol-border text-sol-base1"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
