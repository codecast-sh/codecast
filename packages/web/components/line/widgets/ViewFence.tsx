"use client";
// The `view` fenced block: one view of one thing in a connected app (a Union
// conversation as of a moment, a call), drawn by ProductView wherever markdown
// renders. Its spec is read by lib/productViewRefs. When the app cannot draw
// it, the moment the spec names shows instead, else its link, else the
// reference as written. A spec it cannot read stays the code it is.
import { useMemo } from "react";
import { readViewFence } from "../../../lib/productViewRefs";
import { CodeBlock } from "../../CodeBlock";
import { MomentView } from "./MomentView";
import { ProductView } from "./ProductView";
import { formatProductViewRef } from "@codecast/shared/contracts/productView";

export default function ViewFence({ code }: { code: string }) {
  const read = useMemo(() => readViewFence(code), [code]);
  if (!read.ok) return <CodeBlock code={code} language="json" />;
  const { ref, moment, url, title } = read.spec;
  const fallback = moment ? (
    <MomentView moment={moment} />
  ) : url ? (
    <a className="pv-open" href={url} target="_blank" rel="noreferrer">{title ?? url}</a>
  ) : (
    <code className="pv-ref-text">{formatProductViewRef(ref)}</code>
  );
  return (
    <div className="lw-widget" data-view-fence={ref.view}>
      <ProductView viewRef={ref} fallback={fallback} />
    </div>
  );
}
