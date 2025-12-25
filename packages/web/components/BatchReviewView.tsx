"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ReviewView } from "./ReviewView";
import { useBatchReview } from "./BatchReviewContext";
import { BatchProgressBar } from "./BatchProgressBar";
import { BatchActions } from "./BatchActions";
import { BatchCompletionModal } from "./BatchCompletionModal";

export function BatchReviewView() {
  const router = useRouter();
  const { prIds, currentPrIndex, goToNextPR, goToPrevPR, markPRReviewed, isComplete } =
    useBatchReview();
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(true);

  const currentPrId = prIds[currentPrIndex];

  const mockDiffs = [
    {
      path: "src/components/Header.tsx",
      additions: 5,
      deletions: 2,
      changes: [],
    },
    {
      path: "src/utils/api.ts",
      additions: 8,
      deletions: 0,
      changes: [],
    },
    {
      path: "README.md",
      additions: 3,
      deletions: 1,
      changes: [],
    },
  ];

  const handleKeyPress = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "]") {
        e.preventDefault();
        goToNextPR();
        setCurrentFileIndex(0);
      } else if (e.key === "[") {
        e.preventDefault();
        goToPrevPR();
        setCurrentFileIndex(0);
      } else if (e.key === "Escape") {
        e.preventDefault();
        router.push("/timeline");
      } else if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      } else if (e.key === "a" && e.ctrlKey) {
        e.preventDefault();
        markPRReviewed(currentPrId, "approved");
        if (currentPrIndex < prIds.length - 1) {
          goToNextPR();
          setCurrentFileIndex(0);
        }
      }
    },
    [currentPrId, currentPrIndex, goToNextPR, goToPrevPR, markPRReviewed, prIds.length, router]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [handleKeyPress]);

  useEffect(() => {
    setCurrentFileIndex(0);
  }, [currentPrIndex]);

  return (
    <div className="h-screen flex flex-col bg-sol-bg">
      <BatchProgressBar currentFileIndex={currentFileIndex} totalFiles={mockDiffs.length} />

      <div className="px-4 py-2">
        <BatchActions />
      </div>

      <div className="flex-1 overflow-hidden">
        <ReviewView prId={currentPrId} />
      </div>

      {showShortcuts && (
        <div className="sol-header px-4 py-2 text-xs text-sol-text-muted border-t border-sol-border">
          <div className="flex gap-6">
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                ]
              </kbd>{" "}
              next PR
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                [
              </kbd>{" "}
              prev PR
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                j/k
              </kbd>{" "}
              next/prev file
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                Esc
              </kbd>{" "}
              exit batch mode
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-sol-bg-alt rounded border border-sol-border">
                ?
              </kbd>{" "}
              toggle shortcuts
            </span>
          </div>
        </div>
      )}

      <BatchCompletionModal />
    </div>
  );
}
