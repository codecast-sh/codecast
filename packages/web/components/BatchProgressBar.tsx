import { useBatchReview } from "./BatchReviewContext";

interface BatchProgressBarProps {
  currentFileIndex: number;
  totalFiles: number;
}

export function BatchProgressBar({ currentFileIndex, totalFiles }: BatchProgressBarProps) {
  const { currentPrIndex, prIds, reviewedPrs, approvedPrs, changesRequestedPrs } = useBatchReview();

  const currentPr = currentPrIndex + 1;
  const totalPrs = prIds.length;

  return (
    <div className="sol-header px-4 py-3 border-b border-sol-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="text-sm">
            <span className="text-sol-text font-semibold">
              PR {currentPr}/{totalPrs}
            </span>
            <span className="text-sol-text-muted mx-2">•</span>
            <span className="text-sol-text-muted">
              File {currentFileIndex + 1}/{totalFiles}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {reviewedPrs.size > 0 && (
              <span className="text-xs px-2 py-1 bg-sol-bg-alt rounded text-sol-text-secondary">
                {reviewedPrs.size} reviewed
              </span>
            )}
            {approvedPrs.size > 0 && (
              <span className="text-xs px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded">
                {approvedPrs.size} approved
              </span>
            )}
            {changesRequestedPrs.size > 0 && (
              <span className="text-xs px-2 py-1 bg-red-500/10 text-red-600 dark:text-red-400 rounded">
                {changesRequestedPrs.size} changes requested
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 max-w-md mx-4">
          <div className="h-2 bg-sol-bg-alt rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{
                width: `${(reviewedPrs.size / totalPrs) * 100}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
