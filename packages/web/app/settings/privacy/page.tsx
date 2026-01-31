"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Label } from "../../../components/ui/label";
import { encodeBase64 } from "@codecast/shared/encryption";

type ActivityVisibility = "detailed" | "summary" | "minimal" | "hidden";

const visibilityOptions: { value: ActivityVisibility; label: string; description: string }[] = [
  { value: "detailed", label: "Detailed", description: "Title + bullet summary" },
  { value: "summary", label: "Summary", description: "e.g. \"Worked in codecast for 4h\"" },
  { value: "minimal", label: "Minimal", description: "e.g. \"3 agents in codecast\"" },
  { value: "hidden", label: "Hidden", description: "No activity visible" },
];

export default function PrivacyPage() {
  const user = useQuery(api.users.getCurrentUser);
  const updatePrivacySettings = useMutation(api.users.updatePrivacySettings);

  if (!user) {
    return null;
  }

  const handleActivityVisibilityChange = async (value: ActivityVisibility) => {
    await updatePrivacySettings({ activity_visibility: value });
  };

  const handleToggleEncryption = async () => {
    if (!user.encryption_enabled) {
      const masterKey = crypto.getRandomValues(new Uint8Array(32));
      const masterKeyBase64 = encodeBase64(masterKey);
      await updatePrivacySettings({
        encryption_enabled: true,
        encryption_master_key: masterKeyBase64,
      });
    } else {
      await updatePrivacySettings({
        encryption_enabled: false,
      });
    }
  };

  const currentVisibility = user.activity_visibility || "detailed";

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">Privacy</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sol-text font-medium">Default sharing</div>
              <div className="text-sm text-sol-base1">
                New conversations are private by default
              </div>
            </div>
            <span className="px-3 py-1 rounded-full text-sm font-medium bg-sol-orange/20 text-sol-orange">
              Private
            </span>
          </div>

          <div className="flex items-center justify-between py-3 border-t border-sol-border">
            <div>
              <Label className="text-sol-text font-medium">Activity Visibility</Label>
              <div className="text-sm text-sol-base1">
                What teammates see for your private conversations
              </div>
            </div>
            <select
              value={currentVisibility}
              onChange={(e) => handleActivityVisibilityChange(e.target.value as ActivityVisibility)}
              className="px-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border text-sol-text text-sm focus:outline-none focus:ring-2 focus:ring-sol-cyan/50"
            >
              {visibilityOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="pl-4 py-2 text-xs text-sol-text-muted border-l-2 border-sol-border/50">
            {visibilityOptions.find(o => o.value === currentVisibility)?.description}
            {currentVisibility !== "hidden" && (
              <span className="block mt-1 text-sol-text-dim">
                Shared conversations are always fully visible to teammates.
              </span>
            )}
          </div>

          <div className="flex items-center justify-between py-3 border-t border-sol-border">
            <div>
              <Label className="text-sol-text font-medium">End-to-End Encryption (Enterprise)</Label>
              <div className="text-sm text-sol-base1">
                Encrypt all conversation data client-side before syncing to server
              </div>
            </div>
            <button
              onClick={handleToggleEncryption}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                user.encryption_enabled ? "bg-sol-cyan" : "bg-sol-base02"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  user.encryption_enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      </Card>

    </div>
  );
}
