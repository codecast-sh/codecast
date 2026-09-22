import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { setShareTokenScope } from "../../../lib/shareTokenScope";

export default function SharedConversationClient() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();

  // In-app arrivals only (a profile's pinned session, a deep link the
  // desktop routed here): a document load of /share/<token> never reaches
  // this page, because the web server answers it with the same redirect
  // (server/share.ts). The meta query is the light lookup: the token to its
  // conversation id, without loading the transcript.
  const conversation = useQuery(api.conversations.getSharedConversationMeta, {
    share_token: token,
  });
  const conversationId = conversation?.conversation_id;

  useWatchEffect(() => {
    if (conversationId) {
      // Carry the token through the redirect: the conversation page (and every
      // id-keyed query under it) must PRESENT it — the server no longer grants
      // "shared" access on the token's mere existence (issue #27).
      setShareTokenScope(conversationId, token);
      // Keep the #msg- anchor (bookmark deep links) alongside the token.
      router.replace(
        `/conversation/${conversationId}?share=${encodeURIComponent(token)}${window.location.hash}`
      );
    }
  }, [conversationId, router, token]);

  if (conversation === null) {
    return (
      <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
        <div className="text-center max-w-md px-4">
          <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <h1 className="text-xl text-sol-base0 mb-2">Invalid Link</h1>
          <p className="text-sol-base00 text-sm">
            This share link is invalid or the conversation has been made private.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-sol-base0">Redirecting...</div>
    </main>
  );
}
