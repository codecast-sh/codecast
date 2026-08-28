import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import { AppLoader } from "@/components/AppLoader";
import { readSharePreload, readSharePreloadNow } from "@/lib/sharePreload";
import { SharedMessageNotFound, SharedMessageView } from "./SharedMessageView";

export default function SharedMessageClient() {
  const params = useParams();
  const token = params.token as string;

  const live = useQuery(api.messages.getSharedMessage, { share_token: token });
  // Server-inlined payload paints first (and is what the server-rendered
  // markup was built from, so hydration matches); the live query replaces it
  // once the socket answers. undefined = nothing inlined: loader as before.
  const data = live !== undefined ? live : readSharePreload<typeof live>("message", token);
  // Same clock as the server render until live data arrives, so relative
  // times hydrate without a mismatch.
  const now = live !== undefined ? Date.now() : (readSharePreloadNow() ?? Date.now());

  if (data === undefined) return <AppLoader />;
  if (data === null) return <SharedMessageNotFound />;
  return <SharedMessageView data={data} now={now} />;
}
