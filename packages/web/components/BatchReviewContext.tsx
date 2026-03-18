import { createContext, useContext, useState, ReactNode } from "react";

interface BatchReviewState {
  prIds: string[];
  currentPrIndex: number;
  reviewedPrs: Set<string>;
  approvedPrs: Set<string>;
  changesRequestedPrs: Set<string>;
  goToNextPR: () => void;
  goToPrevPR: () => void;
  markPRReviewed: (prId: string, state: "approved" | "changes_requested") => void;
  approveAllRemaining: () => void;
  isComplete: boolean;
}

const BatchReviewContext = createContext<BatchReviewState | null>(null);

export function useBatchReview() {
  const context = useContext(BatchReviewContext);
  if (!context) {
    throw new Error("useBatchReview must be used within BatchReviewProvider");
  }
  return context;
}

interface BatchReviewProviderProps {
  prIds: string[];
  children: ReactNode;
}

export function BatchReviewProvider({ prIds, children }: BatchReviewProviderProps) {
  const [currentPrIndex, setCurrentPrIndex] = useState(0);
  const [reviewedPrs, setReviewedPrs] = useState<Set<string>>(new Set());
  const [approvedPrs, setApprovedPrs] = useState<Set<string>>(new Set());
  const [changesRequestedPrs, setChangesRequestedPrs] = useState<Set<string>>(new Set());

  const goToNextPR = () => {
    if (currentPrIndex < prIds.length - 1) {
      setCurrentPrIndex((prev) => prev + 1);
    }
  };

  const goToPrevPR = () => {
    if (currentPrIndex > 0) {
      setCurrentPrIndex((prev) => prev - 1);
    }
  };

  const markPRReviewed = (prId: string, state: "approved" | "changes_requested") => {
    setReviewedPrs((prev) => new Set([...prev, prId]));
    if (state === "approved") {
      setApprovedPrs((prev) => new Set([...prev, prId]));
    } else {
      setChangesRequestedPrs((prev) => new Set([...prev, prId]));
    }
  };

  const approveAllRemaining = () => {
    const unreviewedPrIds = prIds.slice(currentPrIndex).filter(prId => !reviewedPrs.has(prId));
    setReviewedPrs((prev) => new Set([...prev, ...unreviewedPrIds]));
    setApprovedPrs((prev) => new Set([...prev, ...unreviewedPrIds]));
  };

  const isComplete = reviewedPrs.size === prIds.length;

  return (
    <BatchReviewContext.Provider
      value={{
        prIds,
        currentPrIndex,
        reviewedPrs,
        approvedPrs,
        changesRequestedPrs,
        goToNextPR,
        goToPrevPR,
        markPRReviewed,
        approveAllRemaining,
        isComplete,
      }}
    >
      {children}
    </BatchReviewContext.Provider>
  );
}
