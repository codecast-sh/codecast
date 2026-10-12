// The markdown door to product views: a `view:<ref>` link payload (written by
// remarkEntityIds) becomes the view itself when hoisted alone on its line, or
// a pill in running text. The component code loads only where one appears.
import { Suspense, lazy } from "react";
import { viewRefFromPayload } from "../../../lib/productViewRefs";

const ProductViewEmbed = lazy(() => import("./ProductView").then((m) => ({ default: m.ProductViewEmbed })));
const ProductViewPill = lazy(() => import("./ProductView").then((m) => ({ default: m.ProductViewPill })));

/** The view a link's payload names, as an embed (`block`) or a pill; null when the payload is not a view reference. */
export function productViewLink(payload: string, block: boolean) {
  const ref = viewRefFromPayload(payload);
  if (!ref) return null;
  return block ? (
    <Suspense fallback={<div className="my-2 h-24 max-w-[860px] rounded-xl border border-sol-border/30 bg-sol-bg-alt/40" aria-busy />}>
      <ProductViewEmbed viewRef={ref} />
    </Suspense>
  ) : (
    <Suspense fallback={<code>{payload.slice(5)}</code>}>
      <ProductViewPill viewRef={ref} />
    </Suspense>
  );
}
