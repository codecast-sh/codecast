"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
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

interface InviteModalProps {
  trigger: React.ReactNode;
}

export function InviteModal({ trigger }: InviteModalProps) {
  const [open, setOpen] = useState(false);
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCopyInviteCode = async () => {
    if (team?.invite_code) {
      await navigator.clipboard.writeText(team.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setTimeout(() => {
      setEmail("");
      setCopied(false);
    }, 200);
  };

  if (!team) return null;

  const isExpired = team.invite_code_expires_at && Date.now() > team.invite_code_expires_at;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
          <DialogDescription>
            Share this invite code with your team
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Invite Code</Label>
            <div className="flex gap-2">
              <Input
                value={team.invite_code || ""}
                readOnly
                className="font-mono"
              />
              <Button
                onClick={handleCopyInviteCode}
                variant="outline"
                size="sm"
              >
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            {isExpired && (
              <p className="text-sm text-destructive">
                This invite code has expired
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-email">Send to email (optional)</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
