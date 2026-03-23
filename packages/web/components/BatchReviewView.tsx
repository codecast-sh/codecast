import { useState, useCallback } from "react";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { KeyCap } from "./KeyboardShortcutsHelp";
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

  useEventListener("keydown", handleKeyPress);

  useWatchEffect(() => { setCurrentFileIndex(0); }, [currentPrIndex]);

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
        <div className="sol-header px-4 py-1.5 text-[10px] text-sol-text-dim border-t border-sol-border/40">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1"><span className="flex items-center gap-[2px]"><KeyCap size="xs">]</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">[</KeyCap></span> PRs</span>
            <span className="flex items-center gap-1"><span className="flex items-center gap-[2px]"><KeyCap size="xs">J</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">K</KeyCap></span> files</span>
            <span className="flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> exit</span>
            <button onClick={() => useInboxStore.getState().toggleShortcutsPanel()} className="ml-auto flex items-center gap-1 hover:text-sol-text-muted transition-colors">
              <KeyCap size="xs">?</KeyCap> all shortcuts
            </button>
          </div>
        </div>
      )}

      <BatchCompletionModal />
    </div>
  );
}
