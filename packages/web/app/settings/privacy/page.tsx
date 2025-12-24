"use client";

import { Card } from "../../../components/ui/card";

export default function PrivacyPage() {
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
        </div>
      </Card>
    </div>
  );
}
