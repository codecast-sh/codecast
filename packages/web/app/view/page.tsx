"use client";
// /view?ref=union:conversation/<id>@<iso>: one connected app's own screen of
// one thing, whole, on a page of its own (contracts/productView.ts). It is
// where a link to a product view lands when the page holding the link cannot
// frame the view itself: a published decision page is sandboxed and holds no
// viewer, so its "open the conversation" links come here (the decision kit's
// <dk-view>, docs/line/decision-kit/README.md).
import { useSearchParams } from "next/navigation";
import { parseProductViewRef } from "@codecast/shared/contracts/productView";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ProductView } from "../../components/line/widgets/ProductView";

/** The whole view: a page of its own has nothing to fold it for. */
const NO_FOLD = 20_000;

function ViewBody() {
  const raw = useSearchParams()?.get("ref") ?? "";
  const ref = parseProductViewRef(raw);
  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-16">
        {ref ? (
          <ProductView viewRef={ref} eager foldAt={NO_FOLD} />
        ) : (
          <div className="pt-16 text-center text-sol-text-dim" data-view-missing>
            {raw ? <>"{raw}" does not name a view.</> : "No view was named."}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ViewPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="View">
        <ViewBody />
      </ErrorBoundary>
    </AuthGuard>
  );
}
