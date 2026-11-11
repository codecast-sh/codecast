// The body of a shared board, sheet or dashboard (/share/doc/<token>): the
// saved layer, read only, drawn by the product's shared view when it has one
// and as the product's own text form otherwise.
import { Suspense } from "react";
import { useParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { describeElements, type ArtifactType } from "@codecast/shared/artifacts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AppLoader } from "../AppLoader";
import { LIVE_SHARED_VIEWS } from "./registry";

export function SharedLiveArtifact({ docType }: { docType: ArtifactType }) {
  const params = useParams();
  const token = String(params?.token ?? "");
  // A shared page reads for an anonymous visitor: no store feeder, its own query.
  const { data } = useQueryNoThrow(api.liveArtifacts.sharedElements, token ? { share_token: token } : "skip");
  if (data === undefined) return <AppLoader className="min-h-[16rem]" />;
  if (data === null) return null;
  const View = LIVE_SHARED_VIEWS[docType];
  if (View) {
    return (
      <Suspense fallback={<AppLoader className="min-h-[16rem]" />}>
        <View doc={data.doc as any} elements={data.elements as any} shareToken={token} />
      </Suspense>
    );
  }
  return (
    <pre className="mt-6 whitespace-pre-wrap text-sm font-mono text-sol-text-muted" data-live-shared>
      {describeElements(docType, data.doc.title, data.elements as any)}
    </pre>
  );
}
