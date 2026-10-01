"use client";
// Killing a role's own session is not how a role stops (org-staffing.md S16):
// the seat would sit empty while its triggers keep firing and its sessions keep
// reporting to it. Every kill gesture on a standing session asks here instead,
// offering the retire (the one retire confirm), the role's page, or the Chief of
// Staff to talk the change over with. The server refuses the bare kill too
// (conversations.killConversation), so no door skips the question.
import { useSyncExternalStore } from "react";
import { seatKillAsk, closeSeatKillAsk } from "../../lib/seatKill";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { RetireRoleConfirm } from "./RetireRoleConfirm";
import { CHIEF_OF_STAFF_HANDLE } from "./orgStaffingTypes";
import { retireToastText } from "../../lib/retireRole";

export function SeatKillDialog() {
  const roleId = useSyncExternalStore(seatKillAsk.subscribe, seatKillAsk.get, () => null);
  const role = useInboxStore((s: any) => (roleId ? s.orgTree?.roles?.find((r: any) => r._id === roleId) ?? null : null));
  const chief = useInboxStore((s: any) => s.orgTree?.roles?.find((r: any) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status !== "retired") ?? null);
  const router = useRouter();
  if (!roleId) return null;
  const close = closeSeatKillAsk;
  const name = role?.name ?? "this role";
  const go = (href: string) => { close(); router.push(href); };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-md" data-seat-kill-dialog>
        <DialogHeader>
          <DialogTitle>Retire {name}?</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed">
            This is {name}'s own session. Killing it would leave the role with nobody doing its work while its checks keep firing. To stop it, retire the role: its sessions and open work go to whoever it reports to. To change what it does instead, talk it over with the Chief of Staff or open its page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2 pt-1">
          {role && <button type="button" onClick={() => go(`/org/${role.short_id}`)} className="h-7 px-3 rounded-md text-[12px] border" style={{ borderColor: "var(--sol-border)", color: "var(--sol-text)" }} data-seat-kill-page>Open its page</button>}
          {chief && chief._id !== roleId && <button type="button" onClick={() => go(`/org/${chief.short_id}`)} className="h-7 px-3 rounded-md text-[12px] border" style={{ borderColor: "var(--sol-border)", color: "var(--sol-text)" }} data-seat-kill-chief>Ask the Chief of Staff</button>}
          {!role && <button type="button" onClick={() => go("/org")} className="h-7 px-3 rounded-md text-[12px] border" style={{ borderColor: "var(--sol-border)", color: "var(--sol-text)" }} data-seat-kill-org>Open the org page</button>}
        </div>
        {role && role.status !== "retired" && (
          <div className="pt-3 mt-1 border-t" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
            <RetireRoleConfirm
              role={role}
              onCancel={close}
              onRetire={(choice) => {
                close();
                (useInboxStore.getState() as any).retireOrgRole(role._id, choice);
                toast.success(retireToastText(role.name, choice));
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
