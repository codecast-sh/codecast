"use client";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";

type Permission = {
  _id: Id<"pending_permissions">;
  tool_name: string;
  arguments_preview?: string;
  status: "pending" | "approved" | "denied";
  created_at: number;
  responded_at?: number;
};

type PermissionCardProps = {
  permission: Permission;
};

export function PermissionCard({ permission }: PermissionCardProps) {
  const updatePermissionStatus = useMutation(api.permissions.updatePermissionStatus);

  const handleApprove = async () => {
    try {
      await updatePermissionStatus({
        permission_id: permission._id,
        status: "approved",
      });
      toast.success("Permission approved");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to approve: ${errMsg}`);
    }
  };

  const handleDeny = async () => {
    try {
      await updatePermissionStatus({
        permission_id: permission._id,
        status: "denied",
      });
      toast.success("Permission denied");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to deny: ${errMsg}`);
    }
  };

  if (permission.status !== "pending") {
    return null;
  }

  return (
    <div className="border-2 border-sol-yellow/50 rounded-lg p-4 bg-sol-yellow/10">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-sol-yellow animate-pulse" />
            <span className="font-semibold text-sol-text">
              Permission Required
            </span>
          </div>
          <div className="text-sm text-sol-text-secondary mb-1">
            <span className="font-mono font-semibold">{permission.tool_name}</span>
          </div>
          {permission.arguments_preview && (
            <div className="text-xs text-sol-text-muted font-mono bg-sol-bg-alt rounded px-2 py-1 mt-2 max-w-xl truncate">
              {permission.arguments_preview}
            </div>
          )}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={handleApprove}
            className="px-4 py-2 bg-sol-green hover:bg-sol-green/80 text-sol-bg rounded font-medium transition-colors"
          >
            Approve
          </button>
          <button
            onClick={handleDeny}
            className="px-4 py-2 bg-sol-red hover:bg-sol-red/80 text-sol-bg rounded font-medium transition-colors"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
