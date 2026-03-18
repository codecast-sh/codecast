import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
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
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { copyToClipboard } from "../lib/utils";

interface InviteModalProps {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function InviteModal({ trigger, open: controlledOpen, onOpenChange }: InviteModalProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const regenerateInviteCode = useMutation(api.teams.regenerateInviteCode);

  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const inviteUrl = team?.invite_code ? `https://codecast.sh/join/${team.invite_code}` : "";

  const handleCopyInviteCode = async () => {
    if (inviteUrl) {
      await copyToClipboard(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegenerate = async () => {
    if (!user?._id || !user?.team_id) return;
    setIsRegenerating(true);
    try {
      await regenerateInviteCode({
        team_id: user.team_id,
        requesting_user_id: user._id,
      });
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setTimeout(() => {
      setCopied(false);
    }, 200);
  };

  if (!team) return null;

  const isExpired = !!(team.invite_code_expires_at && Date.now() > team.invite_code_expires_at);
  const isAdmin = user?.role === "admin";

  const formatExpiry = (timestamp: number | undefined) => {
    if (!timestamp) return "No expiry set";
    const date = new Date(timestamp);
    const now = Date.now();
    const diff = timestamp - now;

    if (diff < 0) return "Expired";

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 0) {
      return `Expires in ${days} day${days === 1 ? "" : "s"}`;
    }
    if (hours > 0) {
      return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `Expires soon`;
  };

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
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sol-base1">Invite Link</Label>
              <span className={`text-xs ${isExpired ? "text-sol-red" : "text-sol-base1"}`}>
                {formatExpiry(team.invite_code_expires_at)}
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                value={inviteUrl}
                readOnly
                className={`font-mono text-sm bg-sol-bg-alt border-sol-border text-sol-text ${isExpired ? "opacity-50" : ""}`}
              />
              <Button
                onClick={handleCopyInviteCode}
                variant="outline"
                disabled={isExpired}
                className="border-sol-border text-sol-base1 hover:bg-sol-bg-alt"
              >
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            {isExpired && (
              <p className="text-sm text-sol-red">
                This invite link has expired. {isAdmin ? "Generate a new one below." : "Ask an admin to regenerate it."}
              </p>
            )}
          </div>

          <div className="pt-3 border-t border-sol-border">
            <div className="text-sm font-medium text-sol-text mb-2">Setup Instructions</div>
            <ol className="text-sm text-sol-base1 space-y-1.5 list-decimal list-inside">
              <li>Share the invite link above with your team member</li>
              <li>They&apos;ll be prompted to sign in or create an account</li>
              <li>After signing in, they&apos;ll automatically join the team</li>
              <li>They can then install the daemon to start syncing conversations</li>
            </ol>
          </div>

          {isAdmin && (
            <div className="pt-2 border-t border-sol-border">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-sol-text">Regenerate Link</div>
                  <div className="text-xs text-sol-base1">Creates a new link valid for 7 days</div>
                </div>
                <Button
                  onClick={handleRegenerate}
                  variant="outline"
                  size="sm"
                  disabled={isRegenerating}
                  className="border-sol-cyan text-sol-cyan hover:bg-sol-cyan/10"
                >
                  {isRegenerating ? "..." : "Regenerate"}
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            className="border-sol-border text-sol-base1"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
