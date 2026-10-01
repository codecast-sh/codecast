"use client";
// The frame every /share/<kind>/<token> page renders in: the token from the
// URL, the public query (seeded by the server's inlined payload when there is
// one), the loader, the dead-link page, and the reading column with its
// footer. A share page only supplies what its object looks like.
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useParams } from "next/navigation";
import type { SharedObjectKind } from "@codecast/shared/entities";
import { AppLoader } from "../../components/AppLoader";
import { readSharePreload } from "@/lib/sharePreload";

function InvalidLink({ noun }: { noun: string }) {
  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-center max-w-md px-4">
        <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <h1 className="text-xl text-sol-base0 mb-2">Invalid Link</h1>
        <p className="text-sol-base00 text-sm">
          This share link is invalid or the {noun} has been made private.
        </p>
      </div>
    </main>
  );
}

export function SharedObjectPage<T>({
  kind,
  query,
  noun,
  children,
}: {
  kind: SharedObjectKind;
  /** The kind's public query, taking `{ share_token }`. */
  query: FunctionReference<"query">;
  /** What the object is called in the dead-link message. */
  noun: string;
  children: (data: T) => ReactNode;
}) {
  const token = useParams().token as string;
  const live = useQuery(query, { share_token: token }) as T | null | undefined;
  const data = live !== undefined ? live : readSharePreload<T>(kind, token);

  if (data === undefined) return <AppLoader className="min-h-0 h-screen bg-sol-base03" />;
  if (data === null) return <InvalidLink noun={noun} />;

  return (
    <main className="min-h-screen bg-sol-base03">
      <div className="max-w-3xl mx-auto px-6 py-12">
        {children(data)}
        <div className="mt-16 pt-6 border-t border-sol-border/10 text-center">
          <a href="https://codecast.sh" className="text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors">
            Shared via Codecast
          </a>
        </div>
      </div>
    </main>
  );
}
