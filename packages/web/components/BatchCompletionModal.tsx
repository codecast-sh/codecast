"use client";

import { useRouter } from "next/navigation";
import { useBatchReview } from "./BatchReviewContext";

export function BatchCompletionModal() {
  const router = useRouter();
  const { isComplete, reviewedPrs, approvedPrs, changesRequestedPrs, prIds } = useBatchReview();

  if (!isComplete) return null;

  const handleExit = () => {
    router.push("/timeline");
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="sol-card p-6 max-w-md w-full mx-4">
        <h2 className="text-xl font-semibold text-sol-text mb-4">
          Batch Review Complete
        </h2>

        <div className="space-y-3 mb-6">
          <div className="flex items-center justify-between text-sm">
            <span className="text-sol-text-muted">Total PRs reviewed:</span>
            <span className="text-sol-text font-semibold">{reviewedPrs.size}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-sol-text-muted">Approved:</span>
            <span className="text-green-600 dark:text-green-400 font-semibold">
              {approvedPrs.size}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-sol-text-muted">Changes requested:</span>
            <span className="text-red-600 dark:text-red-400 font-semibold">
              {changesRequestedPrs.size}
            </span>
          </div>
        </div>

        <div className="bg-sol-bg-alt p-4 rounded-lg mb-6">
          <div className="text-sm text-sol-text-secondary">
            All {prIds.length} PRs have been reviewed. Your feedback has been submitted.
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleExit}
            className="sol-btn-primary flex-1"
          >
            Return to Timeline
          </button>
          <button
            onClick={() => window.location.reload()}
            className="sol-btn-ghost"
          >
            Review Again
          </button>
        </div>
      </div>
    </div>
  );
}
