import { useSearchParams } from "next/navigation";
import { BatchReviewProvider } from "../../../components/BatchReviewContext";
import { BatchReviewView } from "../../../components/BatchReviewView";

export default function BatchReviewPage() {
  const searchParams = useSearchParams();
  const prsParam = searchParams.get("prs");

  if (!prsParam) {
    return (
      <div className="h-screen flex items-center justify-center bg-sol-bg">
        <div className="sol-card p-6 max-w-md">
          <h1 className="text-xl font-semibold text-sol-text mb-2">
            No PRs Selected
          </h1>
          <p className="text-sol-text-muted">
            Use the URL format: /review/batch?prs=id1,id2,id3
          </p>
        </div>
      </div>
    );
  }

  const prIds = prsParam.split(",").filter(Boolean);

  if (prIds.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-sol-bg">
        <div className="sol-card p-6 max-w-md">
          <h1 className="text-xl font-semibold text-sol-text mb-2">
            No PRs Selected
          </h1>
          <p className="text-sol-text-muted">
            Please provide valid PR IDs in the URL.
          </p>
        </div>
      </div>
    );
  }

  return (
    <BatchReviewProvider prIds={prIds}>
      <BatchReviewView />
    </BatchReviewProvider>
  );
}
