"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Label } from "../../../components/ui/label";
import { encodeBase64 } from "@codecast/shared/encryption";

export default function PrivacyPage() {
  const user = useQuery(api.users.getCurrentUser);
  const updatePrivacySettings = useMutation(api.users.updatePrivacySettings);

  if (!user) {
    return null;
  }

  const handleToggleHideActivity = async () => {
    await updatePrivacySettings({ hide_activity: !user.hide_activity });
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
              <Label className="text-sol-text font-medium">Hide Activity</Label>
              <div className="text-sm text-sol-base1">
                Prevent others from seeing your conversations and activity stats
              </div>
            </div>
            <button
              onClick={handleToggleHideActivity}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                user.hide_activity ? "bg-sol-cyan" : "bg-sol-base02"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  user.hide_activity ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
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
