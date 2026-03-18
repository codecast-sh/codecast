import { useBatchReview } from "./BatchReviewContext";

export function BatchActions() {
  const { prIds, currentPrIndex, reviewedPrs, approveAllRemaining, goToNextPR } = useBatchReview();

  const handleSkipToChangesRequested = () => {
    const nextUnreviewedIndex = prIds.findIndex(
      (prId, idx) => idx > currentPrIndex && !reviewedPrs.has(prId)
    );
    if (nextUnreviewedIndex !== -1) {
      goToNextPR();
    }
  };

  const remainingCount = prIds.length - reviewedPrs.size;

  if (remainingCount === 0) return null;

  return (
    <div className="sol-card p-3 flex items-center gap-3">
      <span className="text-sm text-sol-text-muted">Batch actions:</span>
      <button
        onClick={approveAllRemaining}
        className="sol-btn-secondary text-sm"
        disabled={remainingCount === 0}
      >
        Approve all remaining ({remainingCount})
      </button>
      <button
        onClick={handleSkipToChangesRequested}
        className="sol-btn-ghost text-sm"
      >
        Skip to next
      </button>
    </div>
  );
}
